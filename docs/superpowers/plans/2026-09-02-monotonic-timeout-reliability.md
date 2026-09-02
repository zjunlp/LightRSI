# Monotonic Timeout Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local daemon startup and file-lock retry deadlines reliable when WSL wall-clock time jumps forward or backward.

**Architecture:** Preserve `Date.now()` for persisted timestamps, TTL comparisons, lock metadata, and stale-file checks because those compare real filesystem or protocol time. Replace only elapsed-time deadlines and retry-delay calculations with `node:perf_hooks` `performance.now()`, which is monotonic within a running process.

**Tech Stack:** TypeScript, Node.js test runner, `node:perf_hooks`, pnpm workspace.

**Spec:** WSL evidence recorded in the development thread: `Date.now()` alternates by about 178 seconds while `process.hrtime` advances about 20 ms, causing visual daemon startup to fail in under one second despite a five-second timeout.

## Global Constraints

- Do not alter Cleaner plans, task selection, receipts, or protected-item policy.
- Do not use monotonic time for persisted dates, filesystem `mtime` stale checks, or externally visible timestamps.
- Add a failing regression test before every production time-source change.
- Run the relevant focused test before and after each change, then run typecheck.

---

### Task 1: CLI visual daemon startup

**Files:**
- Modify: `components/products/cli/src/hosts/visual-daemon.ts:21-32,141-156`
- Test: `components/products/cli/tests/visual-daemon.test.ts`

**Interfaces:**
- Consumes: `ensureDetachedVisualDaemon` options and existing daemon metadata format.
- Produces: the same URL-or-error contract, with timeouts measured monotically.

- [x] **Step 1: Write the failing regression**

```ts
Object.defineProperty(Date, "now", { value: () => 12_000 });
const url = await ensureDetachedVisualDaemon({ timeoutMs: 1_000, ...params });
assert.match(url, /^http:\/\/127\.0\.0\.1:/);
```

- [x] **Step 2: Verify red**

Run: `corepack pnpm --dir components/products/cli exec node --import tsx --test tests/visual-daemon.test.ts`

Expected: `Failed to start visual daemon` before the child server can publish metadata.

- [x] **Step 3: Replace only visual elapsed deadlines**

```ts
import { performance } from "node:perf_hooks";
const deadline = performance.now() + timeoutMs;
while (performance.now() < deadline) { /* existing work */ }
```

- [x] **Step 4: Verify green**

Run: `corepack pnpm --dir components/products/cli exec node --import tsx --test tests/visual-daemon.test.ts`

Expected: all visual-daemon tests pass.

### Task 2: Adapter daemon health probes

**Files:**
- Modify: `components/adapters/codex/src/daemon.ts:39-45,80-93`
- Modify: `components/adapters/claude-code/src/daemon.ts:48-61`
- Test: `components/adapters/codex/tests/daemon.test.ts`
- Test: `components/adapters/claude-code/tests/daemon.test.ts`

**Interfaces:**
- Consumes: existing process health endpoints and daemon PID files.
- Produces: unchanged daemon status and error messages.

- [x] **Step 1: Extend the existing delayed-health test to jump `Date.now()` after spawning the child**

```ts
const originalDateNow = Date.now;
Object.defineProperty(Date, "now", { value: () => originalDateNow() + 60_000 });
await assert.doesNotReject(() => startDaemon(config, params));
```

- [x] **Step 2: Verify red**

Run: `corepack pnpm --dir components/adapters/codex exec node --import tsx --test tests/daemon.test.ts`

Expected: health probe reports that the daemon did not become healthy.

- [x] **Step 3: Change process-exit and health-probe elapsed deadlines to `performance.now()`**

```ts
const deadline = performance.now() + timeoutMs;
while (performance.now() <= deadline) { /* existing poll */ }
```

- [x] **Step 4: Verify green**

Run: `corepack pnpm --dir components/adapters/codex exec node --import tsx --test tests/daemon.test.ts`

Expected: all Codex daemon tests pass; repeat the equivalent Claude daemon test.

### Task 3: Codex journal and rebase lock waits

**Files:**
- Modify: `components/adapters/codex/src/context-history/journal-append.ts:256-279`
- Modify: `components/adapters/codex/src/context-rewrite/rebase-capability.ts:217-236`
- Test: `components/adapters/codex/tests/context-history-journal.test.ts`

**Interfaces:**
- Consumes: existing lock acquisition and release logic.
- Produces: unchanged lock ownership, stale-lock checks, and timeout errors.

- [x] **Step 1: Add a concurrent lock regression with a forward-jumping `Date.now()`**

```ts
await assert.doesNotReject(() => Promise.all([
  appendCodexRequestJournalEntry(...),
  appendCodexResponseJournalEntry(...),
]));
```

- [x] **Step 2: Verify red**

Run: `corepack pnpm --dir components/adapters/codex exec node --import tsx --test tests/context-history-journal.test.ts`

Expected: lock acquisition expires before the lock holder releases it.

- [x] **Step 3: Use `performance.now()` for lock-acquisition elapsed deadline and retry delay**

```ts
const deadline = performance.now() + timeoutMs;
await wait(Math.min(retryMs, Math.max(1, deadline - performance.now())));
```

- [x] **Step 4: Verify green**

Run: `corepack pnpm --dir components/adapters/codex exec node --import tsx --test tests/context-history-journal.test.ts`

Expected: concurrent and UTF-8-tail lock tests pass.

### Task 4: Shared plan and Cleaner schedule/store locks

**Files:**
- Modify: `components/packages/foundation/host-adapter/src/context-rewrite/plan-store.ts:333-383`
- Modify: `components/packages/features/cleaner/src/clean-store-support.ts:52-87`
- Modify: `components/adapters/claude-code/src/context-cleaner/scheduler.ts:170-204`
- Test: the existing lock/concurrency tests adjacent to each module.

**Interfaces:**
- Consumes: wall-clock `mtime` for stale lock recovery and persisted lock file ownership.
- Produces: the same transaction and schedule state transitions.

- [x] **Step 1: Add a held-lock retry test that advances `Date.now()` without advancing elapsed time**

```ts
const release = await acquireFirstLock();
const second = acquireSecondLock();
advanceDateNowOnly();
await release();
await assert.doesNotReject(() => second);
```

- [x] **Step 2: Verify red**

Run the affected module's existing lock tests.

Expected: the second acquisition reports its existing lock-timeout result prematurely.

- [x] **Step 3: Keep `Date.now()` for `mtime` stale checks and change only process-local elapsed timeout comparisons to `performance.now()`**

```ts
const startedAt = performance.now();
if (performance.now() - startedAt >= LOCK_TIMEOUT_MS) return undefined;
```

- [x] **Step 4: Verify green**

Run the same focused tests plus `corepack pnpm --dir components/packages/features/cleaner test`.

### Task 5: Verify in native WSL

**Files:** No production changes.

- [ ] **Step 1: Build CLI and both adapters in `~/src/lightrsi-ci`**

```bash
corepack pnpm --dir components/products/cli build
corepack pnpm --dir components/adapters/codex build
corepack pnpm --dir components/adapters/claude-code build
```

- [ ] **Step 2: Run repeated bridge and daemon tests**

```bash
corepack pnpm --dir components/products/cli test
corepack pnpm --dir components/adapters/claude-code test
corepack pnpm --dir components/adapters/codex test
```

- [ ] **Step 3: Record exact pass/fail counts and do not call the repository fully green unless every selected command exits 0.**
