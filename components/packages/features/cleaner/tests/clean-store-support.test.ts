import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { withContextCleanStoreLock } from "../src/clean-store-support.js";

test("clean store lock waits for its owner when the wall clock jumps forward", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lightrsi-clean-store-monotonic-"));
  const originalDateNow = Date.now;
  let releaseFirst: (() => void) | undefined;
  let enteredFirst: (() => void) | undefined;
  const firstEntered = new Promise<void>((resolve) => {
    enteredFirst = resolve;
  });
  const releaseGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  try {
    const first = withContextCleanStoreLock({
      stateDir,
      planId: "plan-monotonic",
      action: async () => {
        enteredFirst?.();
        await releaseGate;
        return "first";
      },
    });
    await firstEntered;

    let lockClockCalls = 0;
    Object.defineProperty(Date, "now", {
      configurable: true,
      value: () => {
        const stack = new Error().stack ?? "";
        if (!stack.includes("withContextCleanStoreLock")) return originalDateNow();
        lockClockCalls += 1;
        return lockClockCalls <= 3 ? 1_000 : 12_000;
      },
    });

    const second = withContextCleanStoreLock({
      stateDir,
      planId: "plan-monotonic",
      action: async () => "second",
    });
    void second.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 30));
    releaseFirst?.();

    assert.equal(await first, "first");
    assert.equal(await second, "second");
  } finally {
    Object.defineProperty(Date, "now", { configurable: true, value: originalDateNow });
    releaseFirst?.();
    await rm(stateDir, { recursive: true, force: true });
  }
});
