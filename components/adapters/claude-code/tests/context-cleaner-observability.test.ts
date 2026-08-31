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
  appendClaudeCleanerCommitted,
  appendClaudeCleanerTerminal,
  claudeCleanerScheduleJournalPath,
  scheduleClaudeCleanerPlan,
} from "../src/context-cleaner/scheduler.js";
import { readClaudeCleanerObservability } from "../src/context-cleaner/observability.js";
import { normalizeTokenPilotClaudeCodeConfig } from "../src/config.js";
import { formatClaudeCodeDoctorReport, inspectClaudeCodeDoctor } from "../src/doctor.js";
import { renderClaudeCodeSessionReport } from "../src/session-report.js";
import { upsertClaudeCodeSessionSnapshot } from "../src/session-state.js";

const SESSION_ID = "claude-cleaner-observability-session";
const PLAN_ID = "claude-cleaner-observability-plan";
const REVISION = "claude-cleaner-observability-revision";
const TIMESTAMP = "2026-08-31T00:00:00.000Z";

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-cleaner-observability-"));
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
    hostId: "claude-code",
    sessionId: SESSION_ID,
    baseRevision,
    usedTokens: null,
    usedChars: 400,
    protectedTokens: null,
    protectedChars: 329,
    unassignedTokens: null,
    unassignedChars: 0,
    tokenCountMode: "chars_only",
    tokenCountMethod: "utf16_chars",
    createdAt: TIMESTAMP,
    tasks: [{
      taskId: "PRIVATE_TASK_ID",
      label: "PRIVATE_TASK_LABEL",
      description: "PRIVATE_TASK_DESCRIPTION",
      summary: "PRIVATE_TASK_SUMMARY",
      lifecycleState: "completed",
      itemIds: ["PRIVATE_ITEM_ID"],
      itemDigests: { PRIVATE_ITEM_ID: "PRIVATE_ITEM_DIGEST" },
      tokenCount: null,
      charCount: 71,
      tokenPercent: null,
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
    hostId: "claude-code",
    sessionId: SESSION_ID,
    status: "scheduled",
    selectedTaskIds: ["PRIVATE_TASK_ID"],
    estimatedSavedTokens: null,
    estimatedSavedChars: 71,
    tokenCountMode: "chars_only",
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
  assert.equal((await scheduleClaudeCleanerPlan({
    stateDir,
    sessionId: SESSION_ID,
    cleanPlanId: PLAN_ID,
    baseRevision: options.scheduleBaseRevision ?? REVISION,
    selectedTaskIds: options.scheduleSelectedTaskIds ?? ["PRIVATE_TASK_ID"],
    scheduledAt: TIMESTAMP,
  })).outcome, "stored");
}

test("reports a scheduled Claude clean with estimate-only metadata", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir);

    const observation = await readClaudeCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "available",
      planStore: "available",
      pendingPlan: "scheduled",
      lastReceipt: "scheduled",
      rewriteMode: "request_overlay",
      savings: {
        estimated: { tokens: null, chars: 71 },
        scheduled: { tokens: null, chars: 71 },
      },
      fallbackCount: 0,
    });
    assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_/u);
  });
});

test("reports actual Claude savings only after the shared receipt is applied", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir);
    await transitionContextCleanState({
      stateDir,
      receipt: {
        ...scheduledReceipt(),
        status: "applied",
        appliedSavedTokens: null,
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
    assert.equal((await appendClaudeCleanerCommitted({
      stateDir,
      sessionId: SESSION_ID,
      cleanPlanId: PLAN_ID,
      mutationPlanId: "PRIVATE_MUTATION_PLAN",
      overlayId: "PRIVATE_OVERLAY",
      updatedAt: "2026-08-31T00:00:01.000Z",
    })).outcome, "transitioned");

    const observation = await readClaudeCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "available",
      planStore: "available",
      pendingPlan: "none",
      lastReceipt: "applied",
      rewriteMode: "request_overlay",
      savings: {
        estimated: { tokens: null, chars: 71 },
        applied: { tokens: null, chars: 59 },
      },
      fallbackCount: 0,
    });
    assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_/u);
  });
});

test("counts a terminal Claude fallback without reporting applied savings", async () => {
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
    assert.equal((await appendClaudeCleanerTerminal({
      stateDir,
      sessionId: SESSION_ID,
      cleanPlanId: PLAN_ID,
      receiptStatus: "failed",
      reasons: ["PRIVATE_FALLBACK_REASON"],
      updatedAt: "2026-08-31T00:00:01.000Z",
    })).outcome, "transitioned");

    const observation = await readClaudeCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "available",
      planStore: "available",
      pendingPlan: "none",
      lastReceipt: "failed",
      rewriteMode: "request_overlay",
      savings: { estimated: { tokens: null, chars: 71 } },
      fallbackCount: 1,
    });
    assert.doesNotMatch(JSON.stringify(observation), /PRIVATE_/u);
  });
});

test("degrades safely when a Claude schedule references a missing shared plan", async () => {
  await withTempState(async (stateDir) => {
    assert.equal((await scheduleClaudeCleanerPlan({
      stateDir,
      sessionId: SESSION_ID,
      cleanPlanId: PLAN_ID,
      baseRevision: REVISION,
      selectedTaskIds: ["PRIVATE_TASK_ID"],
      scheduledAt: TIMESTAMP,
    })).outcome, "stored");

    const observation = await readClaudeCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "missing",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "request_overlay",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("degrades safely when a Claude schedule has no matching shared receipt", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir);
    await rm(contextCleanReceiptFilePath(stateDir, PLAN_ID));

    const observation = await readClaudeCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "available",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "request_overlay",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("degrades when a Claude schedule revision diverges from its shared plan", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir, {
      planBaseRevision: "PRIVATE_DIFFERENT_REVISION",
    });

    const observation = await readClaudeCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "unknown",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "request_overlay",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("degrades when a Claude schedule selection diverges from its frozen receipt", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir, {
      scheduleSelectedTaskIds: ["PRIVATE_OTHER_TASK"],
    });

    const observation = await readClaudeCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "unknown",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "request_overlay",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("degrades when a Claude terminal schedule conflicts with its receipt", async () => {
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
    assert.equal((await appendClaudeCleanerTerminal({
      stateDir,
      sessionId: SESSION_ID,
      cleanPlanId: PLAN_ID,
      receiptStatus: "cancelled",
      reasons: ["PRIVATE_FALLBACK_REASON"],
      updatedAt: "2026-08-31T00:00:01.000Z",
    })).outcome, "transitioned");

    const observation = await readClaudeCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "unknown",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "request_overlay",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("fails open when the Claude cleaner schedule journal is corrupt", async () => {
  await withTempState(async (stateDir) => {
    const path = claudeCleanerScheduleJournalPath(stateDir, SESSION_ID);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "not-json\\n", "utf8");

    const observation = await readClaudeCleanerObservability({ stateDir, sessionId: SESSION_ID });

    assert.deepEqual(observation, {
      availability: "degraded",
      planStore: "unknown",
      pendingPlan: "unknown",
      lastReceipt: "unknown",
      rewriteMode: "request_overlay",
      savings: {},
      fallbackCount: null,
    });
  });
});

test("renders Claude Cleaner doctor and report metadata without task content", async () => {
  await withTempState(async (stateDir) => {
    await writeScheduledCleanerState(stateDir);
    await upsertClaudeCodeSessionSnapshot(stateDir, SESSION_ID, {
      latestResponseId: "message-observability",
      latestModel: "claude-test",
    });

    const doctor = await inspectClaudeCodeDoctor({
      config: normalizeTokenPilotClaudeCodeConfig({ stateDir, proxyPort: 43124 }),
      settingsPath: join(stateDir, "settings.json"),
      tokenPilotConfigPath: join(stateDir, "tokenpilot.json"),
      mcpConfigPath: join(stateDir, "mcp.json"),
    });
    const doctorText = formatClaudeCodeDoctorReport(doctor);
    const reportText = await renderClaudeCodeSessionReport(stateDir, SESSION_ID);

    assert.match(doctorText, /Cleaner capability: available/i);
    assert.match(doctorText, /Cleaner plan store: available/i);
    assert.match(doctorText, /Cleaner pending plan: scheduled/i);
    assert.match(doctorText, /Cleaner last receipt: scheduled/i);
    assert.match(doctorText, /Cleaner rewrite mode: request_overlay/i);
    assert.match(reportText, /Cleaner estimated savings: tokens unavailable, 71 chars/i);
    assert.match(reportText, /Cleaner scheduled savings: tokens unavailable, 71 chars/i);
    assert.match(reportText, /Cleaner applied savings: none/i);
    assert.match(reportText, /Cleaner fallback count: 0/i);
    assert.doesNotMatch(`${doctorText}\n${reportText}`, /PRIVATE_/u);
  });
});
