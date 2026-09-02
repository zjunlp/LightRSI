import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireClaudeCleanerScheduleLock,
  readClaudeCleanerSchedule,
  scheduleClaudeCleanerPlan,
} from "../src/context-cleaner/scheduler.js";

const SESSION = "claude-cleaner-schedule-session";
const PLAN = "clean-plan-1";
const REVISION = "claude-rev-base";
const SCHEDULED_AT = "2026-08-28T00:00:00.000Z";

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-claude-cleaner-schedule-"));
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("stores one replay-safe Claude schedule for the frozen selected task ids", async () => {
  await withTempState(async (stateDir) => {
    const request = {
      stateDir,
      sessionId: SESSION,
      cleanPlanId: PLAN,
      baseRevision: REVISION,
      selectedTaskIds: ["task-completed"],
      scheduledAt: SCHEDULED_AT,
    };

    const stored = await scheduleClaudeCleanerPlan(request);
    const replayed = await scheduleClaudeCleanerPlan(request);
    const current = await readClaudeCleanerSchedule({ stateDir, sessionId: SESSION });

    assert.equal(stored.outcome, "stored");
    assert.equal(replayed.outcome, "unchanged");
    assert.equal(current.outcome, "ready");
    if (current.outcome !== "ready") return;
    assert.deepEqual(current.record.selectedTaskIds, ["task-completed"]);
    assert.equal(current.record.cleanPlanId, PLAN);
    assert.equal(current.record.baseRevision, REVISION);
  });
});

test("Claude cleaner schedule lock waits for its owner when the wall clock jumps forward", async () => {
  await withTempState(async (stateDir) => {
    const firstLock = await acquireClaudeCleanerScheduleLock({ stateDir, sessionId: SESSION });
    assert.ok(firstLock);
    const originalDateNow = Date.now;
    let lockClockCalls = 0;

    Object.defineProperty(Date, "now", {
      configurable: true,
      value: () => {
        const stack = new Error().stack ?? "";
        if (!stack.includes("acquireClaudeCleanerScheduleLock")) return originalDateNow();
        lockClockCalls += 1;
        return lockClockCalls <= 3 ? 1_000 : 12_000;
      },
    });

    try {
      const secondLock = acquireClaudeCleanerScheduleLock({ stateDir, sessionId: SESSION });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await firstLock?.release();
      assert.ok(await secondLock);
      await (await secondLock)?.release();
    } finally {
      Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
      await firstLock?.release();
    }
  });
});
