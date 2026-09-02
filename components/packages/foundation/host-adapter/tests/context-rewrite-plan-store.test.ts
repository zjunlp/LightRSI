import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CONTEXT_MUTATION_PLAN_STORE_SCHEMA_VERSION,
  MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
  contextMutationPlanFilePath,
  contextMutationPlanLockPath,
  contextMutationPlanQuarantineDir,
  contextMutationPlanSessionRoot,
  contextMutationPlanStatusDir,
  loadActiveContextMutationPlans,
  loadContextMutationPlans,
  markContextMutationPlanApplied,
  markContextMutationPlanFailed,
  saveActiveContextMutationPlan,
  type ContextMutationPlan,
} from "../src/index.js";

function createPlan(
  planId: string,
  sessionId = "session-1",
): ContextMutationPlan {
  return {
    schemaVersion: MODEL_CONTEXT_REWRITE_SCHEMA_VERSION,
    planId,
    hostId: "test-host",
    sessionId,
    baseRevision: "ctxrev-v1-base",
    sourceModuleId: "eviction",
    operations: [
      {
        id: `operation-${planId}`,
        type: "remove",
        targetItemIds: [`item-${planId}`],
        targetItemFingerprints: {
          [`item-${planId}`]: `fingerprint-${planId}`,
        },
        rationale: "evicted completed task",
        estimatedSavedChars: 10,
      },
    ],
    createdAt: "2026-08-02T00:00:00.000Z",
  };
}

test("plan store schema version is locked to 1", () => {
  assert.equal(CONTEXT_MUTATION_PLAN_STORE_SCHEMA_VERSION, 1);
});

test("active plans persist idempotently and recover after restart", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-restart-"));
  try {
    const plan = createPlan("plan-1");
    const first = await saveActiveContextMutationPlan({
      stateDir,
      plan,
      storedAt: "2026-08-02T00:01:00.000Z",
    });
    const duplicate = await saveActiveContextMutationPlan({
      stateDir,
      plan: { ...plan, operations: plan.operations.map((operation) => ({ ...operation })) },
      storedAt: "2026-08-02T00:02:00.000Z",
    });
    const recovered = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: plan.sessionId,
    });

    assert.equal(first.outcome, "stored");
    assert.equal(duplicate.outcome, "unchanged");
    assert.equal(duplicate.status, "active");
    assert.equal(recovered.bypassed, false);
    assert.deepEqual(recovered.plans.map((entry) => entry.planId), ["plan-1"]);

    const files = await readdir(
      contextMutationPlanStatusDir(stateDir, plan.sessionId, "active"),
    );
    assert.equal(files.filter((name) => name.endsWith(".json")).length, 1);
    assert.equal(files.some((name) => name.endsWith(".tmp")), false);

    const sessionRoot = contextMutationPlanSessionRoot(stateDir, plan.sessionId);
    await assert.rejects(access(join(sessionRoot, "latest.json")));
    await assert.rejects(access(join(sessionRoot, "revisions.jsonl")));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("same plan id rejects different content instead of treating it as idempotent", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-id-conflict-"));
  try {
    const plan = createPlan("plan-conflict");
    await saveActiveContextMutationPlan({ stateDir, plan });
    const conflict = await saveActiveContextMutationPlan({
      stateDir,
      plan: {
        ...plan,
        operations: plan.operations.map((operation) => ({
          ...operation,
          rationale: "different decision",
        })),
      },
    });

    assert.equal(conflict.outcome, "bypassed");
    assert.deepEqual(conflict.reasons, ["plan_id_conflict"]);
    const loaded = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: plan.sessionId,
    });
    assert.equal(loaded.plans[0]?.operations[0]?.rationale, "evicted completed task");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("persistence strips unknown plan and operation fields", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-canonical-"));
  try {
    const plan = createPlan("plan-canonical");
    const unsafePlan = {
      ...plan,
      rawHostPayload: { authorization: "Bearer secret" },
      operations: plan.operations.map((operation) => ({
        ...operation,
        adapterMetadata: { apiKey: "secret" },
      })),
    } as ContextMutationPlan;
    const stored = await saveActiveContextMutationPlan({ stateDir, plan: unsafePlan });
    assert.equal(stored.outcome, "stored");

    const path = contextMutationPlanFilePath(
      stateDir,
      plan.sessionId,
      "active",
      plan.planId,
    );
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      plan: Record<string, unknown> & { operations: Record<string, unknown>[] };
    };
    assert.equal("rawHostPayload" in persisted.plan, false);
    assert.equal("adapterMetadata" in persisted.plan.operations[0]!, false);

    const loaded = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: plan.sessionId,
    });
    assert.equal("rawHostPayload" in (loaded.plans[0] as object), false);
    assert.equal("adapterMetadata" in (loaded.plans[0]!.operations[0] as object), false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("fingerprint maps preserve special item ids as data keys", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-special-key-"));
  try {
    const plan = createPlan("plan-special-key");
    plan.operations[0]!.targetItemIds = ["__proto__"];
    plan.operations[0]!.targetItemFingerprints = Object.fromEntries([
      ["__proto__", "fingerprint-special"],
    ]);
    const stored = await saveActiveContextMutationPlan({ stateDir, plan });
    assert.equal(stored.outcome, "stored");

    const loaded = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: plan.sessionId,
    });
    const fingerprints = loaded.plans[0]?.operations[0]?.targetItemFingerprints;
    assert.deepEqual(Object.keys(fingerprints ?? {}), ["__proto__"]);
    assert.equal(fingerprints?.["__proto__"], "fingerprint-special");
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("active plans move atomically into separate terminal states", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-status-"));
  try {
    const appliedPlan = createPlan("plan-applied");
    const failedPlan = createPlan("plan-failed");
    await saveActiveContextMutationPlan({ stateDir, plan: appliedPlan });
    await saveActiveContextMutationPlan({ stateDir, plan: failedPlan });

    const applied = await markContextMutationPlanApplied({
      stateDir,
      sessionId: appliedPlan.sessionId,
      planId: appliedPlan.planId,
    });
    const failed = await markContextMutationPlanFailed({
      stateDir,
      sessionId: failedPlan.sessionId,
      planId: failedPlan.planId,
    });
    const appliedAgain = await markContextMutationPlanApplied({
      stateDir,
      sessionId: appliedPlan.sessionId,
      planId: appliedPlan.planId,
    });
    const terminalReplay = await saveActiveContextMutationPlan({
      stateDir,
      plan: appliedPlan,
    });

    assert.equal(applied.outcome, "transitioned");
    assert.equal(failed.outcome, "transitioned");
    assert.equal(appliedAgain.outcome, "unchanged");
    assert.equal(terminalReplay.outcome, "unchanged");
    assert.equal(terminalReplay.status, "applied");

    const active = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: appliedPlan.sessionId,
    });
    const appliedPlans = await loadContextMutationPlans({
      stateDir,
      sessionId: appliedPlan.sessionId,
      status: "applied",
    });
    const failedPlans = await loadContextMutationPlans({
      stateDir,
      sessionId: appliedPlan.sessionId,
      status: "failed",
    });
    assert.deepEqual(active.plans, []);
    assert.deepEqual(appliedPlans.plans.map((plan) => plan.planId), ["plan-applied"]);
    assert.deepEqual(failedPlans.plans.map((plan) => plan.planId), ["plan-failed"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("marking a missing plan as applied does not create an applied marker", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-missing-applied-"));
  try {
    const result = await markContextMutationPlanApplied({
      stateDir,
      sessionId: "session-missing-applied",
      planId: "plan-does-not-exist",
    });

    assert.equal(result.outcome, "missing");
    assert.equal(result.bypassed, true);
    assert.deepEqual(result.reasons, ["plan_not_found"]);
    await assert.rejects(access(contextMutationPlanFilePath(
      stateDir,
      "session-missing-applied",
      "applied",
      "plan-does-not-exist",
    )));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("corrupt active plan cannot be marked applied", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-corrupt-applied-"));
  try {
    const plan = createPlan("plan-corrupt-applied");
    const activePath = contextMutationPlanFilePath(
      stateDir,
      plan.sessionId,
      "active",
      plan.planId,
    );
    await mkdir(dirname(activePath), { recursive: true });
    await writeFile(activePath, "{not-json", "utf8");

    const result = await markContextMutationPlanApplied({
      stateDir,
      sessionId: plan.sessionId,
      planId: plan.planId,
    });

    assert.equal(result.outcome, "bypassed");
    assert.equal(result.bypassed, true);
    assert.deepEqual(result.reasons, ["corrupt_plan_quarantined"]);
    await assert.rejects(access(contextMutationPlanFilePath(
      stateDir,
      plan.sessionId,
      "applied",
      plan.planId,
    )));
    const quarantineFiles = await readdir(
      contextMutationPlanQuarantineDir(stateDir, plan.sessionId, "active"),
    );
    assert.equal(quarantineFiles.length, 1);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("failed plan cannot later be marked applied", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-failed-applied-"));
  try {
    const plan = createPlan("plan-failed-terminal");
    await saveActiveContextMutationPlan({ stateDir, plan });
    const failed = await markContextMutationPlanFailed({
      stateDir,
      sessionId: plan.sessionId,
      planId: plan.planId,
    });
    assert.equal(failed.outcome, "transitioned");
    assert.equal(failed.status, "failed");

    const applied = await markContextMutationPlanApplied({
      stateDir,
      sessionId: plan.sessionId,
      planId: plan.planId,
    });
    assert.equal(applied.outcome, "bypassed");
    assert.equal(applied.bypassed, true);
    assert.deepEqual(applied.reasons, ["plan_terminal_status_conflict"]);
    const appliedPlans = await loadContextMutationPlans({
      stateDir,
      sessionId: plan.sessionId,
      status: "applied",
    });
    assert.deepEqual(appliedPlans.plans, []);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("every status loader detects a plan stored in multiple statuses", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-status-conflict-"));
  try {
    const plan = createPlan("plan-status-conflict");
    await saveActiveContextMutationPlan({ stateDir, plan });
    const activePath = contextMutationPlanFilePath(
      stateDir,
      plan.sessionId,
      "active",
      plan.planId,
    );
    const failedPath = contextMutationPlanFilePath(
      stateDir,
      plan.sessionId,
      "failed",
      plan.planId,
    );
    await mkdir(dirname(failedPath), { recursive: true });
    await writeFile(failedPath, await readFile(activePath, "utf8"), "utf8");

    for (const status of ["active", "failed"] as const) {
      const loaded = await loadContextMutationPlans({
        stateDir,
        sessionId: plan.sessionId,
        status,
      });
      assert.equal(loaded.bypassed, true);
      assert.deepEqual(loaded.plans, []);
      assert.deepEqual(loaded.reasons, ["plan_status_conflict"]);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("session lock serializes concurrent active plan writes", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-concurrent-"));
  try {
    const plans = Array.from({ length: 12 }, (_, index) =>
      createPlan(`plan-${String(index).padStart(2, "0")}`));
    const results = await Promise.all(plans.map((plan) =>
      saveActiveContextMutationPlan({
        stateDir,
        plan,
        lock: { lockTimeoutMs: 5_000, lockRetryMs: 2 },
      })));
    const loaded = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: "session-1",
    });

    assert.equal(results.every((result) => result.outcome === "stored"), true);
    assert.equal(loaded.bypassed, false);
    assert.deepEqual(
      loaded.plans.map((plan) => plan.planId),
      plans.map((plan) => plan.planId),
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("corrupt active plan is quarantined and causes one safe bypass", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-corrupt-"));
  try {
    const validPlan = createPlan("plan-valid");
    const corruptPlan = createPlan("plan-corrupt");
    await saveActiveContextMutationPlan({ stateDir, plan: validPlan });
    const corruptPath = contextMutationPlanFilePath(
      stateDir,
      corruptPlan.sessionId,
      "active",
      corruptPlan.planId,
    );
    await mkdir(dirname(corruptPath), { recursive: true });
    await writeFile(corruptPath, "{not-json", "utf8");

    const bypassed = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: validPlan.sessionId,
    });
    assert.equal(bypassed.bypassed, true);
    assert.deepEqual(bypassed.plans, []);
    assert.equal(bypassed.quarantinedFileCount, 1);
    assert.ok(bypassed.reasons.includes("corrupt_plan_quarantined"));

    const quarantineFiles = await readdir(
      contextMutationPlanQuarantineDir(
        stateDir,
        validPlan.sessionId,
        "active",
      ),
    );
    assert.equal(quarantineFiles.length, 1);

    const recovered = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: validPlan.sessionId,
    });
    assert.equal(recovered.bypassed, false);
    assert.deepEqual(recovered.plans.map((plan) => plan.planId), ["plan-valid"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("corrupt terminal conflict is quarantined before active plans resume", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-terminal-corrupt-"));
  try {
    const plan = createPlan("plan-terminal-corrupt");
    await saveActiveContextMutationPlan({ stateDir, plan });
    const corruptTerminalPath = contextMutationPlanFilePath(
      stateDir,
      plan.sessionId,
      "applied",
      plan.planId,
    );
    await mkdir(dirname(corruptTerminalPath), { recursive: true });
    await writeFile(corruptTerminalPath, "{not-json", "utf8");

    const bypassed = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: plan.sessionId,
    });
    assert.equal(bypassed.bypassed, true);
    assert.deepEqual(bypassed.plans, []);
    assert.equal(bypassed.quarantinedFileCount, 1);
    assert.deepEqual(bypassed.reasons, ["corrupt_plan_quarantined"]);

    const recovered = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: plan.sessionId,
    });
    assert.equal(recovered.bypassed, false);
    assert.deepEqual(recovered.plans.map((entry) => entry.planId), [plan.planId]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("unsupported future schema bypasses without quarantining the file", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-future-"));
  try {
    const plan = createPlan("plan-future");
    const path = contextMutationPlanFilePath(
      stateDir,
      plan.sessionId,
      "active",
      plan.planId,
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      schemaVersion: 2,
      storedAt: "2026-08-02T00:01:00.000Z",
      plan,
      futureField: true,
    }), "utf8");

    const loaded = await loadActiveContextMutationPlans({
      stateDir,
      sessionId: plan.sessionId,
    });
    assert.equal(loaded.bypassed, true);
    assert.deepEqual(loaded.reasons, ["unsupported_schema"]);
    assert.equal(loaded.quarantinedFileCount, 0);
    assert.equal(JSON.parse(await readFile(path, "utf8")).schemaVersion, 2);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("stale session lock is recovered while a live lock causes bypass", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-lock-"));
  try {
    const stalePlan = createPlan("plan-after-stale");
    const lockPath = contextMutationPlanLockPath(stateDir, stalePlan.sessionId);
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "stale-owner",
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: "2026-08-01T00:00:00.000Z",
    }), "utf8");

    const recovered = await saveActiveContextMutationPlan({
      stateDir,
      plan: stalePlan,
      lock: { lockTimeoutMs: 50, lockRetryMs: 2 },
    });
    assert.equal(recovered.outcome, "stored");

    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "live-owner",
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    }), "utf8");
    const blocked = await saveActiveContextMutationPlan({
      stateDir,
      plan: createPlan("plan-blocked"),
      lock: { lockTimeoutMs: 20, lockRetryMs: 2 },
    });
    assert.equal(blocked.outcome, "bypassed");
    assert.deepEqual(blocked.reasons, ["session_lock_unavailable"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("plan store waits for a live session lock when the wall clock jumps forward", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-monotonic-lock-"));
  const originalDateNow = Date.now;
  try {
    const plan = createPlan("plan-monotonic-lock");
    const lockPath = contextMutationPlanLockPath(stateDir, plan.sessionId);
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "live-owner",
      pid: process.pid,
      hostname: hostname(),
      createdAt: new Date().toISOString(),
    }), "utf8");

    let lockClockCalls = 0;
    Object.defineProperty(Date, "now", {
      configurable: true,
      value: () => {
        const stack = new Error().stack ?? "";
        if (!stack.includes("acquireSessionLock")) return originalDateNow();
        lockClockCalls += 1;
        if (lockClockCalls === 1) return 1_000;
        if (lockClockCalls === 2) return originalDateNow();
        return 12_000;
      },
    });

    const stored = saveActiveContextMutationPlan({
      stateDir,
      plan,
      lock: { lockTimeoutMs: 500, lockRetryMs: 10 },
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(lockPath, { recursive: true, force: true });

    const result = await stored;
    assert.equal(result.outcome, "stored");
  } finally {
    Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("concurrent stale-lock recovery does not remove a new lock owner", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-stale-race-"));
  try {
    const sessionId = "session-stale-race";
    const lockPath = contextMutationPlanLockPath(stateDir, sessionId);
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      token: "stale-owner",
      pid: 2_147_483_647,
      hostname: hostname(),
      createdAt: "2026-08-01T00:00:00.000Z",
    }), "utf8");

    const plans = Array.from({ length: 8 }, (_, index) =>
      createPlan(`plan-stale-race-${index}`, sessionId));
    const results = await Promise.all(plans.map((plan) =>
      saveActiveContextMutationPlan({
        stateDir,
        plan,
        lock: { lockTimeoutMs: 5_000, lockRetryMs: 2 },
      })));
    assert.equal(results.every((result) => result.outcome === "stored"), true);

    const loaded = await loadActiveContextMutationPlans({ stateDir, sessionId });
    assert.equal(loaded.bypassed, false);
    assert.deepEqual(
      loaded.plans.map((plan) => plan.planId),
      plans.map((plan) => plan.planId),
    );
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("adapter-owned replacement payloads are rejected before persistence", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-payload-"));
  try {
    const plan = createPlan("plan-raw-payload");
    const unsafePlan = {
      ...plan,
      operations: [{
        ...plan.operations[0]!,
        replacementItems: [{ rawHostMessage: "secret" }],
      }],
    } as unknown as ContextMutationPlan;
    const result = await saveActiveContextMutationPlan({
      stateDir,
      plan: unsafePlan,
    });

    assert.equal(result.outcome, "bypassed");
    assert.deepEqual(result.reasons, ["invalid_plan"]);
    await assert.rejects(access(contextMutationPlanFilePath(
      stateDir,
      plan.sessionId,
      "active",
      plan.planId,
    )));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("malformed operation identity and fingerprint scope are rejected", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-invalid-"));
  try {
    const base = createPlan("plan-invalid");
    const invalidOperations: ContextMutationPlan["operations"][] = [
      [{ ...base.operations[0]!, id: " " }],
      [{ ...base.operations[0]!, targetItemIds: [] }],
      [{ ...base.operations[0]!, targetItemIds: ["item", "item"] }],
      [{
        ...base.operations[0]!,
        targetItemIds: ["item-a"],
        targetItemFingerprints: { "item-b": "fingerprint" },
      }],
      [base.operations[0]!, { ...base.operations[0]! }],
    ];

    for (const [index, operations] of invalidOperations.entries()) {
      const plan = {
        ...base,
        planId: `plan-invalid-${index}`,
        operations,
      };
      const result = await saveActiveContextMutationPlan({ stateDir, plan });
      assert.equal(result.outcome, "bypassed");
      assert.deepEqual(result.reasons, ["invalid_plan"]);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("plan and store timestamps must use canonical ISO format", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-plan-store-date-"));
  try {
    const plan = createPlan("plan-date");
    const invalidPlan = await saveActiveContextMutationPlan({
      stateDir,
      plan: { ...plan, createdAt: "August 2, 2026" },
    });
    const invalidStoredAt = await saveActiveContextMutationPlan({
      stateDir,
      plan,
      storedAt: "August 2, 2026",
    });
    assert.deepEqual(invalidPlan.reasons, ["invalid_plan"]);
    assert.deepEqual(invalidStoredAt.reasons, ["stored_at_invalid"]);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
