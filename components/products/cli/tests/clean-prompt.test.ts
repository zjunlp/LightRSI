import assert from "node:assert/strict";
import test from "node:test";

import { createInitialCleanPromptState } from "../src/clean-prompt.js";
import type { CleanPlanView } from "../src/clean-renderer.js";

function plan(): CleanPlanView {
  return {
    planId: "plan-1",
    hostId: "codex",
    sessionId: "session-1",
    contextWindowTokens: 100,
    usedTokens: 80,
    usedChars: 320,
    protectedTokens: 20,
    protectedChars: 80,
    unassignedTokens: 0,
    unassignedChars: 0,
    tokenCountMode: "estimated",
    tasks: [
      { taskId: "task-completed", label: "Completed", description: "Completed work", lifecycleState: "completed", tokenCount: 60,
        charCount: 240, tokenPercent: 75, recommendation: "clean", reasonCodes: [], selectable: true },
      { taskId: "system", label: "System", description: "System instructions", lifecycleState: "protected", tokenCount: 20,
        charCount: 80, tokenPercent: 25, recommendation: "protected", reasonCodes: ["system_instruction"], selectable: false },
    ],
  };
}

test("interactive clean starts with no selection and shows the complete plan", () => {
  const state = createInitialCleanPromptState(plan());

  assert.deepEqual(state.selectedTaskIds, []);
  assert.match(state.text, /Context usage: 80 \/ 100 tok \(80\.0%\)/);
  assert.match(state.text, /\[ \].*task-completed/);
  assert.match(state.text, /\[-\].*system.*System instructions/);
  assert.match(state.text, /Protected context: 20 tok/);
});
