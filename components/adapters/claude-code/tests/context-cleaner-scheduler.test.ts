import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
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
