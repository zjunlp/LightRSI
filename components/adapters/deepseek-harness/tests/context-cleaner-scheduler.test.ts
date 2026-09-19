import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  cancelDshCleanerSchedule,
  claimDshCleanerSchedule,
  finalizeDshCleanerSchedule,
  readDshCleanerSchedule,
  scheduleDshCleanerPlan,
} from "../src/context-cleaner/scheduler.js";

const scheduledAt = "2026-09-18T00:00:00.000Z";

function scheduleInput(stateDir: string, cleanPlanId = "ctxclean-one") {
  return {
    stateDir,
    sessionId: "cleaner-scheduler-test",
    cleanPlanId,
    baseRevision: "dsh-surf-test",
    selectedTaskIds: ["completed-task"],
    scheduledAt,
  };
}

describe("DSH Context Cleaner schedule pointer", () => {
  it("serializes concurrent writers after recovering a stale lock owner", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-schedule-"));
    try {
      const input = scheduleInput(stateDir);
      const digest = createHash("sha256").update(input.sessionId).digest("hex").slice(0, 32);
      const lock = join(stateDir, "cleaner-schedule", `${digest}.lock`);
      await mkdir(lock, { recursive: true });
      await writeFile(join(lock, "owner.json"), JSON.stringify({
        token: "dead-owner",
        pid: 2_147_483_647,
        hostname: hostname(),
        createdAt: "2026-09-18T00:00:00.000Z",
      }), "utf8");

      const results = await Promise.all(
        Array.from({ length: 8 }, () => scheduleDshCleanerPlan(input)),
      );
      assert.equal(results.filter((result) => result.outcome === "stored").length, 1);
      assert.equal(results.every((result) =>
        result.outcome === "stored" || result.outcome === "unchanged"), true);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("is idempotent, reserves exactly one execution, then permits a new plan after terminalization", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-schedule-"));
    try {
      const first = await scheduleDshCleanerPlan(scheduleInput(stateDir));
      assert.equal(first.outcome, "stored");

      const replay = await scheduleDshCleanerPlan(scheduleInput(stateDir));
      assert.equal(replay.outcome, "unchanged");

      const claim = await claimDshCleanerSchedule(scheduleInput(stateDir));
      assert.equal(claim.outcome, "claimed");
      if (claim.outcome !== "claimed") return;

      const concurrent = await claimDshCleanerSchedule(scheduleInput(stateDir));
      assert.equal(concurrent.outcome, "already-claimed");

      const final = await finalizeDshCleanerSchedule({
        stateDir,
        sessionId: "cleaner-scheduler-test",
        cleanPlanId: "ctxclean-one",
        receiptStatus: "applied",
        reasons: [],
        claimId: claim.record.claimId,
        updatedAt: "2026-09-18T00:00:01.000Z",
      });
      assert.equal(final.outcome, "transitioned");

      const terminal = await readDshCleanerSchedule({ stateDir, sessionId: "cleaner-scheduler-test" });
      assert.equal(terminal.outcome, "terminal");
      if (terminal.outcome === "terminal") assert.equal(terminal.record.receiptStatus, "applied");

      const later = await scheduleDshCleanerPlan({
        ...scheduleInput(stateDir, "ctxclean-two"),
        scheduledAt: "2026-09-18T00:01:00.000Z",
      });
      assert.equal(later.outcome, "stored", "a terminal receipt must not permanently lock the session");
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  it("lets cancellation win only before a runtime has claimed the plan", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-dsh-schedule-"));
    try {
      await scheduleDshCleanerPlan(scheduleInput(stateDir));
      const cancelled = await cancelDshCleanerSchedule({
        stateDir,
        sessionId: "cleaner-scheduler-test",
        cleanPlanId: "ctxclean-one",
        reasons: ["cancelled_by_user"],
        updatedAt: "2026-09-18T00:00:02.000Z",
      });
      assert.equal(cancelled.outcome, "transitioned");

      const afterCancel = await claimDshCleanerSchedule(scheduleInput(stateDir));
      assert.equal(afterCancel.outcome, "terminal");

      await scheduleDshCleanerPlan({
        ...scheduleInput(stateDir, "ctxclean-two"),
        scheduledAt: "2026-09-18T00:01:00.000Z",
      });
      const claim = await claimDshCleanerSchedule({
        stateDir,
        sessionId: "cleaner-scheduler-test",
        cleanPlanId: "ctxclean-two",
      });
      assert.equal(claim.outcome, "claimed");
      const tooLate = await cancelDshCleanerSchedule({
        stateDir,
        sessionId: "cleaner-scheduler-test",
        cleanPlanId: "ctxclean-two",
        reasons: ["cancelled_by_user"],
      });
      assert.equal(tooLate.outcome, "conflict");
      assert.deepEqual(tooLate.reasons, ["dsh_cleaner_schedule_claimed_conflict"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
