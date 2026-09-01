import assert from "node:assert/strict";
import test from "node:test";

import { renderCleanPlan, renderCleanReceipt } from "../src/clean-renderer.js";

test("clean renderer shows task-level accounting without item ids", () => {
  const text = renderCleanPlan({
    planId: "plan-1",
    hostId: "codex",
    sessionId: "session-1",
    contextWindowTokens: 100,
    usedTokens: 80,
    usedChars: 320,
    protectedTokens: 10,
    protectedChars: 40,
    unassignedTokens: 0,
    unassignedChars: 0,
    tokenCountMode: "estimated",
    tasks: [
      { taskId: "task-a", label: "Finished work", description: "Finished the requested work",
        lifecycleState: "completed", tokenCount: 60, charCount: 240, tokenPercent: 75,
        recommendation: "clean", reasonCodes: ["completed_and_cold"], selectable: true },
      { taskId: "task-current", label: "Current work", description: "Work in progress",
        lifecycleState: "active", tokenCount: 20, charCount: 80, tokenPercent: 25,
        recommendation: "protected", reasonCodes: ["deterministic_protection"], selectable: false },
    ],
  });
  assert.match(text, /Context clean plan plan-1/);
  assert.match(text, /Context usage: 80 \/ 100 tok \(80\.0%\)/);
  assert.match(text, /Protected context: 10 tok/);
  assert.match(text, /Unassigned context: 0 tok/);
  assert.match(text, /\[ \].*task-a.*Finished the requested work.*60 tok.*75\.0%.*clean/);
  assert.match(text, /\[-\].*task-current.*Work in progress.*20 tok.*25\.0%.*protected/);
  assert.match(text, /completed_and_cold/);
  assert.match(text, /Reasons task-a: completed_and_cold/);
  assert.doesNotMatch(text, /item-/);
});

test("receipt renderer distinguishes estimates from applied savings", () => {
  const text = renderCleanReceipt({
    planId: "plan-1",
    status: "applied",
    selectedTaskIds: ["task-a"],
    estimatedSavedTokens: 60,
    estimatedSavedChars: 240,
    appliedSavedTokens: 55,
    appliedSavedChars: 220,
    deferredTaskIds: [],
    reasons: [],
  });
  assert.match(text, /Estimated savings: 60 tok/);
  assert.match(text, /Released: 55 tok/);
});
