import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CONTEXT_CLEAN_SCHEMA_VERSION,
  contextCleanReceiptFilePath,
  saveContextCleanPlan,
  transitionContextCleanState,
  type ContextCleanPendingReceipt,
  type ContextCleanPlan,
} from "@lightrsi/cleaner";

import {
  appendCodexCleanerCommitted,
  appendCodexCleanerTerminal,
  codexCleanerScheduleJournalPath,
  scheduleCodexCleanerPlan,
} from "../src/context-cleaner/scheduler.js";
import { readCodexCleanerObservability } from "../src/context-cleaner/observability.js";
import { normalizeTokenPilotCodexConfig } from "../src/config.js";
import { formatCodexDoctorReport, inspectCodexDoctor } from "../src/doctor.js";
import { renderCodexSessionReport } from "../src/session-report.js";
import { upsertCodexSessionSnapshot } from "../src/session-state.js";

const SESSION_ID = "codex-cleaner-observability-session";
const PLAN_ID = "codex-cleaner-observability-plan";
const REVISION = "codex-cleaner-observability-revision";
const TIMESTAMP = "2026-08-31T00:00:00.000Z";

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-codex-cleaner-observability-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function plan(baseRevision = REVISION): ContextCleanPlan {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: PLAN_ID,
    hostId: "codex",
    sessionId: SESSION_ID,
    baseRevision,
    usedTokens: 100,
    usedChars: 400,
    protectedTokens: 83,
    protectedChars: 329,
    unassignedTokens: 0,
    unassignedChars: 0,
    tokenCountMode: "exact",
    tokenCountMethod: "test-tokenizer",
    createdAt: TIMESTAMP,
    tasks: [{
      taskId: "PRIVATE_TASK_ID",
      label: "PRIVATE_TASK_LABEL",
      description: "PRIVATE_TASK_DESCRIPTION",
      summary: "PRIVATE_TASK_SUMMARY",
      lifecycleState: "completed",
      itemIds: ["PRIVATE_ITEM_ID"],
      itemDigests: { PRIVATE_ITEM_ID: "PRIVATE_ITEM_DIGEST" },
      tokenCount: 17,
      charCount: 71,
      tokenPercent: 17,
      recommendation: "clean",
      reasonCodes: ["PRIVATE_REASON"],
      selectable: true,
    }],
  };
}

function scheduledReceipt(): ContextCleanPendingReceipt {
  return {
    schemaVersion: CONTEXT_CLEAN_SCHEMA_VERSION,
    planId: PLAN_ID,
    hostId: "codex",
    sessionId: SESSION_ID,
    status: "scheduled",
    selectedTaskIds: ["PRIVATE_TASK_ID"],
    estimatedSavedTokens: 17,
    estimatedSavedChars: 71,
    tokenCountMode: "exact",
    deferredTaskIds: [],
    fallbackUsed: false,
    reasons: [],
    updatedAt: TIMESTAMP,
  };
}

async function writeScheduledCleanerState(
  stateDir: string,
  options: {
    planBaseRevision?: string;
    scheduleBaseRevision?: string;
    scheduleSelectedTaskIds?: string[];
  } = {},
): Promise<void> {
  assert.equal((await saveContextCleanPlan({
    stateDir,
    plan: plan(options.planBaseRevision),
  })).outcome, "stored");
  await transitionContextCleanState({
    stateDir,
    receipt: { ...scheduledReceipt(), status: "approved" },
  });
  await transitionContextCleanState({ stateDir, receipt: scheduledReceipt() });
  assert.equal((await scheduleCodexCleanerPlan({
    stateDir,
    sessionId: SESSION_ID,
    cleanPlanId: PLAN_ID,
    baseRevision: options.scheduleBaseRevision ?? REVISION,
    selectedTaskIds: options.scheduleSelectedTaskIds ?? ["PRIVATE_TASK_ID"],
    scheduledAt: TIMESTAMP,
  })).outcome, "stored");
}

test("reports a scheduled Codex clean with estimate-only metadata", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir);

    const observation = await readCodexCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "available",
      planStore: "available",
      pendingPlan: "scheduled",
      lastReceipt: "scheduled",
      rewriteMode: "response_chain_rebase",
      savings: {
        estimated: { tokens: 17, chars: 71 },
        scheduled: { tokens: 17, chars: 71 },
      },
      fallbackCount: 0,
    });
    assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_/u);
  });
});

test("reports actual Codex savings only after the shared receipt is applied", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir);
    await transitionContextCleanState({
      stateDir,
      receipt: {
        ...scheduledReceipt(),
        status: "applied",
        appliedSavedTokens: 13,
        appliedSavedChars: 59,
        evidence: {
          previousRevision: REVISION,
          nextRevision: "next-revision",
          operationIds: ["PRIVATE_OPERATION_ID"],
          itemIds: ["PRIVATE_ITEM_ID"],
        },
        updatedAt: "2026-08-31T00:00:01.000Z",
      },
    });
    assert.equal((await appendCodexCleanerCommitted({
      stateDir,
      sessionId: SESSION_ID,
      cleanPlanId: PLAN_ID,
      mutationPlanId: "PRIVATE_MUTATION_PLAN",
      epochId: "PRIVATE_EPOCH",
      updatedAt: "2026-08-31T00:00:01.000Z",
    })).outcome, "transitioned");

    const observation = await readCodexCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "available",
      planStore: "available",
      pendingPlan: "none",
      lastReceipt: "applied",
      rewriteMode: "response_chain_rebase",
      savings: {
        estimated: { tokens: 17, chars: 71 },
        applied: { tokens: 13, chars: 59 },
      },
      fallbackCount: 0,
    });
    assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_/u);
  });
});

test("counts a terminal Codex fallback without reporting applied savings", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir);
    await transitionContextCleanState({
      stateDir,
      receipt: {
        ...scheduledReceipt(),
        status: "failed",
        fallbackUsed: true,
        reasons: ["PRIVATE_FALLBACK_REASON"],
        updatedAt: "2026-08-31T00:00:01.000Z",
      },
    });
    assert.equal((await appendCodexCleanerTerminal({
      stateDir,
      sessionId: SESSION_ID,
      cleanPlanId: PLAN_ID,
      receiptStatus: "failed",
      reasons: ["PRIVATE_FALLBACK_REASON"],
      updatedAt: "2026-08-31T00:00:01.000Z",
    })).outcome, "transitioned");

    const observation = await readCodexCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "available",
      planStore: "available",
      pendingPlan: "none",
      lastReceipt: "failed",
      rewriteMode: "response_chain_rebase",
      savings: { estimated: { tokens: 17, chars: 71 } },
      fallbackCount: 1,
    });
    assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_/u);
  });
});

test("degrades safely when a Codex schedule references a missing shared plan", async () => {
  await withTempState(async (stateDir) => {
    assert.equal((await scheduleCodexCleanerPlan({
      stateDir,
      sessionId: SESSION_ID,
      cleanPlanId: PLAN_ID,
      baseRevision: REVISION,
      selectedTaskIds: ["PRIVATE_TASK_ID"],
      scheduledAt: TIMESTAMP,
    })).outcome, "stored");

    const observation = await readCodexCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "missing",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "response_chain_rebase",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("degrades safely when a Codex schedule has no matching shared receipt", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir);
    await rm(contextCleanReceiptFilePath(stateDir, PLAN_ID));

    const observation = await readCodexCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "available",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "response_chain_rebase",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("degrades when a Codex schedule revision diverges from its shared plan", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir, {
      planBaseRevision: "PRIVATE_DIFFERENT_REVISION",
    });

    const observation = await readCodexCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "unknown",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "response_chain_rebase",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("degrades when a Codex schedule selection diverges from its frozen receipt", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir, {
      scheduleSelectedTaskIds: ["PRIVATE_OTHER_TASK"],
    });

    const observation = await readCodexCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "unknown",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "response_chain_rebase",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("degrades when a Codex terminal schedule conflicts with its receipt", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir);
    await transitionContextCleanState({
      stateDir,
      receipt: {
        ...scheduledReceipt(),
        status: "failed",
        fallbackUsed: true,
        reasons: ["PRIVATE_FALLBACK_REASON"],
        updatedAt: "2026-08-31T00:00:01.000Z",
      },
    });
    assert.equal((await appendCodexCleanerTerminal({
      stateDir,
      sessionId: SESSION_ID,
      cleanPlanId: PLAN_ID,
      receiptStatus: "cancelled",
      reasons: ["PRIVATE_FALLBACK_REASON"],
      updatedAt: "2026-08-31T00:00:01.000Z",
    })).outcome, "transitioned");

    const observation = await readCodexCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "unknown",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "response_chain_rebase",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("fails open when the Codex cleaner schedule journal is corrupt", async () => {
  await withTempState(async (stateDir) => {
    const path = codexCleanerScheduleJournalPath(stateDir, SESSION_ID);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not-json\\n", "utf8");

    const observation = await readCodexCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "unknown",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "response_chain_rebase",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("renders Codex Cleaner doctor and report metadata without task content", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir);
    await upsertCodexSessionSnapshot(stateDir, SESSION_ID, {
      latestResponseId: "response-observability",
      latestModel: "gpt-test",
    });

    const doctor = await inspectCodexDoctor({
      config: normalizeTokenPilotCodexConfig({ stateDir, proxyPort: 43123 }),
      configPath: join(stateDir, "config.toml"),
      tokenPilotConfigPath: join(stateDir, "tokenpilot.json"),
      hooksConfigPath: join(stateDir, "hooks.json"),
    });
    const doctorText = formatCodexDoctorReport(doctor);
    const reportText = await renderCodexSessionReport(stateDir, SESSION_ID);

    assert.match(doctorText, /Cleaner capability: available/i);
    assert.match(doctorText, /Cleaner plan store: available/i);
    assert.match(doctorText, /Cleaner pending plan: scheduled/i);
    assert.match(doctorText, /Cleaner last receipt: scheduled/i);
    assert.match(doctorText, /Cleaner rewrite mode: response_chain_rebase/i);
    assert.match(reportText, /Cleaner estimated savings: 17 tokens, 71 chars/i);
    assert.match(reportText, /Cleaner scheduled savings: 17 tokens, 71 chars/i);
    assert.match(reportText, /Cleaner applied savings: none/i);
    assert.match(reportText, /Cleaner fallback count: 0/i);
    assert.doesNotMatch(`${doctorText}\n${reportText}`, /PRIVATE_/u);
  });
});
