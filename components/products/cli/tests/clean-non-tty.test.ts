import assert from "node:assert/strict";
import test from "node:test";

import { handleCleanCommand, type CleanCommandBackend } from "../src/clean.js";

test("non-interactive clean is analysis-only and never calls approve", async () => {
  let approved = false;
  const backend: CleanCommandBackend = {
    async analyze() {
      return {
        planId: "plan-non-tty", hostId: "claude-code", sessionId: "session-1",
        usedTokens: null, usedChars: 400, protectedTokens: null, protectedChars: 100,
        unassignedTokens: null, unassignedChars: 0, tokenCountMode: "chars",
        tasks: [{ taskId: "task-a", label: "Finished", description: "Finished task", lifecycleState: "completed", tokenCount: null,
          charCount: 300, tokenPercent: null, recommendation: "clean", reasonCodes: [], selectable: true }],
      };
    },
    async readPlan() { return undefined; },
    async approve() { approved = true; throw new Error("must not approve"); },
    async readReceipt() { return undefined; },
    async cancel() { throw new Error("unused"); },
  };
  const result = await handleCleanCommand({ args: [], sessionId: "session-1", backend, interactive: false });
  assert.equal(approved, false);
  assert.match(result.text, /Analysis only \(non-interactive\)/);
  assert.match(result.text, /1\. task-a - Finished/);
  assert.match(result.text, /None selected by default/);
  assert.match(result.text, /--plan plan-non-tty --select/);
  assert.match(result.text, /Recommended selection estimate: 300 chars/);
});
