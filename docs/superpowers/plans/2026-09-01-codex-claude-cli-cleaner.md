# Codex and Claude Code CLI Cleaner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the documented human-approved Cleaner CLI flow for Codex and Claude Code, including analysis, explicit approval, Host scheduling, status, cancellation, and constrained command skills.

**Architecture:** Shared Cleaner code assembles and persists metadata-only plans; Codex and Claude adapters expose analysis and keep native schedule/rewrite behavior; the CLI composes those public boundaries and owns only command parsing and interactive presentation. OpenClaw stays outside this plan.

**Tech Stack:** TypeScript, Node test runner with `tsx`, pnpm workspaces, existing Cleaner plan/receipt stores, Codex response-chain rebase, Claude gateway overlay.

**Spec:** `docs/superpowers/specs/2026-09-01-codex-claude-cli-cleaner-design.md`

## Global Constraints

- Do not import CLI or adapters from `@lightrsi/cleaner`.
- Do not import Cleaner from foundation/product-surface packages.
- Do not read native journals, messages, or transcripts in the CLI.
- Do not persist raw payloads, adapter metadata, selected item IDs, or digests in Host-local schedule journals.
- Never default-select tasks or change a stale selection to another item.
- Write a failing behavior test before every production change.
- After each task, run its targeted test and inspect the diff against historical Cleaner bugs.
- Preserve `docs/handoffs/` as an untracked user artifact.

---

### Task 1: Add metadata-only analysis contracts

**Files:**
- Modify: `components/packages/features/cleaner/src/contracts.ts`
- Modify: `components/packages/features/cleaner/src/index.ts`
- Test: `components/packages/features/cleaner/tests/contracts.test.ts`

**Interfaces:** Adds `ContextCleanHostAnalysis`, `ContextCleanPlanStatus`, and `ContextCleanerHostBridge.readCleanAnalysis(sessionId)`. The new analysis value contains canonical snapshot, optional context window, and task evidence only.

- [ ] Write a bridge fixture test whose `readCleanAnalysis` has no raw payload or `adapterMetadata`, then run `pnpm --dir components/packages/features/cleaner exec node --import tsx --test tests/contracts.test.ts` and observe the missing-contract failure.
- [ ] Add only the public analysis/status types, bridge method, and index exports; rerun the same test until it passes.
- [ ] Review system/developer protection and malformed-tool protocol coverage; inspect the diff to confirm no native content, Host schedule item ID, or digest field leaked into the new interface.

### Task 2: Add analyzed-plan and selection workflow

**Files:**
- Create: `components/packages/features/cleaner/src/analysis.ts`
- Create: `components/packages/features/cleaner/src/clean-control-plane.ts`
- Create: `components/packages/features/cleaner/src/clean-workflow.ts`
- Modify: `components/packages/features/cleaner/src/index.ts`
- Test: `components/packages/features/cleaner/tests/clean-workflow.test.ts`

**Interfaces:** `createContextCleanWorkflow({ bridge, recommendationProvider, stateDir })` returns `analyze`, `selectAndSchedule`, `readStatus`, and `cancel`. `selectAndSchedule` accepts plan/task IDs only and derives frozen items/digests from the persisted plan.

- [ ] Test with a real temporary plan store and metadata-only bridge: `analyze` persists `analyzed`; selecting protected/unknown tasks rejects; known literal task IDs produce frozen literal item IDs/digests; stale snapshot does not schedule different items. Run the new test and observe the missing-module failure.
- [ ] Implement the smallest workflow using existing `buildContextCleanBreakdown`, recommendation fallback, plan-store validation, and execution bridge; rerun the test until green.
- [ ] Run existing `token-accounting.test.ts` and `host-execution-bridge.test.ts`; inspect all historical protections: system/developer attribution, malformed pair, non-tool `callId`, fractional provider tokens, duplicate evidence.

### Task 3: Make adapter scheduling transactionally ordered

**Files:**
- Modify: `components/packages/features/cleaner/src/host-execution-bridge.ts`
- Modify: `components/packages/features/cleaner/src/contracts.ts`
- Modify: `components/packages/features/cleaner/tests/host-execution-bridge.test.ts`
- Modify: `components/adapters/codex/src/context-cleaner/bridge.ts`
- Modify: `components/adapters/claude-code/src/context-cleaner/bridge.ts`
- Test: `components/adapters/codex/tests/context-cleaner-bridge.test.ts`
- Test: `components/adapters/claude-code/tests/context-cleaner-bridge.test.ts`

**Interfaces:** Keep public `executeApprovedClean`; internally perform frozen approval validation, Host-local pointer write, then shared approved-to-scheduled transition.

- [ ] Add Codex/Claude tests where the local schedule write fails and the shared plan remains `approved`; add success tests proving local journal contains only plan/session/revision identity. Run each targeted test and observe the existing ordering failure.
- [ ] Implement the two-phase transaction by reusing existing locks, snapshot revalidation, stale handling, and tool closure validator; rerun all three targeted bridge tests until green.
- [ ] Examine crash/replay paths between pointer and shared receipt, cancelled plans, and duplicate item/operation IDs. Record no speculative fix: add a new regression test before any discovered correction.

### Task 4: Expose Codex and Claude canonical analysis

**Files:**
- Create: `components/adapters/codex/src/context-cleaner/analysis.ts`
- Create: `components/adapters/claude-code/src/context-cleaner/analysis.ts`
- Modify: `components/adapters/codex/src/context-cleaner/{bridge,index}.ts`
- Modify: `components/adapters/claude-code/src/context-cleaner/{bridge,index}.ts`
- Test: `components/adapters/codex/tests/context-cleaner-bridge.test.ts`
- Test: `components/adapters/claude-code/tests/context-cleaner-bridge.test.ts`

**Interfaces:** Both adapters implement `readCleanAnalysis`. Codex reads committed effective history and registry evidence; Claude reads its canonical persisted snapshot and registry evidence.

- [ ] Add failing tests showing both hosts return canonical snapshot/task evidence without raw payload, and that incomplete Codex history or missing/corrupt Claude snapshot rejects safely.
- [ ] Implement each analysis module by reusing existing snapshot/registry/stable-ID helpers. Never infer task IDs from message index or turn ID; retain unassigned and protected items.
- [ ] Rerun targeted adapter tests. Review against prior bridge hardening: Host-ID validation, full approval forwarding, corrupt-state handling, and no raw persistence.

### Task 5: Add non-interactive canonical CLI commands

**Files:**
- Create: `components/products/cli/src/clean-args.ts`
- Create: `components/products/cli/src/clean-renderer.ts`
- Create: `components/products/cli/src/clean.ts`
- Modify: `components/products/cli/src/{dispatch,usage}.ts`
- Modify: `components/products/cli/package.json`
- Modify: `pnpm-lock.yaml`
- Test: `components/products/cli/tests/{clean-args,clean,dispatch}.test.ts`

**Interfaces:** Parses only documented `clean` forms and consumes an injected workflow. The non-TTY controller returns plan/status/cancel text and never reads adapter state.

- [ ] Write failing parser/controller tests for conflicting flags, empty `--select`, non-TTY plan plus exact next command without scheduling, separated status savings, and cancellation.
- [ ] Implement strict parser, renderer, and `dispatch.ts` clean route before generic host command forwarding. Support `--session` only for clean; render chars-only honestly and retain full snapshot denominator. Add direct Cleaner dependency only when compiler requires it.
- [ ] Rerun focused CLI tests and trace CLI input to workflow to prove task label/index/model output cannot become item selection.

### Task 6: Add TTY multiselect and confirmation

**Files:**
- Create: `components/products/cli/src/clean-prompt.ts`
- Modify: `components/products/cli/src/{clean,package.json}`
- Modify: `pnpm-lock.yaml`
- Test: `components/products/cli/tests/clean.test.ts`

**Interfaces:** `ContextCleanPrompt.selectTaskIds` and `ContextCleanPrompt.confirm` are injected in tests and active only when both streams are TTY.

- [ ] Add failing tests that selectable tasks begin unchecked, protected rows are absent from selectable choices, declined confirmation leaves plan analyzed, and one literal selected task schedules once.
- [ ] Implement a CLI-only multiselect/confirm adapter with `false` as confirmation default. Empty selection, Ctrl-C, prompt failure, and no TTY must never schedule.
- [ ] Rerun focused CLI tests and inspect all control paths for any default selection or implicit confirmation.

### Task 7: Compose Codex and Claude workflows in CLI host runtimes

**Files:**
- Modify: `components/products/cli/src/hosts/{registry,codex,claude-code,factory}.ts`
- Test: `components/products/cli/tests/{shared-hosts,clean}.test.ts`

**Interfaces:** Adds optional `createCleanerRuntime` to Codex/Claude registrations only. OpenClaw returns a clear unsupported result without loading native state.

- [ ] Add failing composition tests that create workflows from each Host public bridge factory and assert OpenClaw clean does not construct a runtime.
- [ ] Implement composition using existing path/config resolution and recommendation provider or safe fallback. Keep native bridge construction in current CLI host files.
- [ ] Rerun composition tests and `pnpm check:boundaries`; inspect imports for any CLI-to-journal/messages/registry dependency.

### Task 8: Add constrained command skills

**Files:**
- Modify: `components/adapters/shared/command-skill-bridge.ts`
- Modify: `components/adapters/codex/tests/install.test.ts`
- Modify: `components/adapters/claude-code/tests/install.test.ts`

**Interfaces:** Adds analysis-only `lightrsi-clean` to both installers and removes only known legacy clean skill names.

- [ ] Write failing behavior tests that install into a temporary directory, run the generated command through a fake CLI, and prove it calls only `clean`; prove `lightmem2-clean` is removed but an unrelated user skill remains.
- [ ] Implement skill generation with explicit prohibition of selection, cancellation, confirmation, and follow-up execution. Preserve Codex explicit-invocation and Claude disabled-model-invocation policies.
- [ ] Rerun installer tests and verify generated behavior rather than only matching its source text.

### Task 9: Run regression gates and final scope audit

**Files:** all files changed above

- [ ] Run `pnpm --dir components/packages/features/cleaner typecheck`, `pnpm --dir components/packages/features/cleaner test`, `pnpm --dir components/products/cli typecheck`, and `pnpm --dir components/products/cli test`.
- [ ] Run `pnpm --dir components/adapters/codex typecheck`, `pnpm --dir components/adapters/codex test`, `pnpm --dir components/adapters/claude-code typecheck`, and `pnpm --dir components/adapters/claude-code test`.
- [ ] Run `pnpm check:boundaries`, `pnpm typecheck`, `pnpm build`, and `git diff --check`.
- [ ] Audit the diff for frozen approval, applied-only actual savings, protected accounting, malformed protocol protection, duplicate evidence, Claude upstream-first settlement, Codex response-chain fallback, absence of OpenClaw/generated work, and preservation of `docs/handoffs/`.
