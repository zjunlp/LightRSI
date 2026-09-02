# Codex and Claude Code CLI Cleaner Design

## Goal

Provide the documented, human-approved Cleaner workflow for Codex and Claude Code through the canonical CLI without changing OpenClaw. The workflow is inspect, explain, approve, schedule, apply on the Host's next request, and verify through an applied receipt.

## Scope

The supported commands are exactly:

```bash
lightrsi <host> clean
lightrsi <host> clean --session <session-id>
lightrsi <host> clean --plan <plan-id> --select <task-id,...>
lightrsi <host> clean --status <plan-id>
lightrsi <host> clean --cancel <plan-id>
```

`<host>` is `codex` or `claude-code`. The existing legacy form `lightrsi <host> session <session-id> clean` remains accepted. OpenClaw is explicitly out of scope.

## Non-negotiable rules

- A model never selects item IDs, constructs a deletion/rewrite command, or confirms a clean operation.
- User approval freezes the existing `taskId`, `itemIds`, and `itemDigests`; names, text search, message indexes, and newly chosen items never expand selection.
- System/developer, current/active/unresolved content, ambiguous attribution, and malformed or incomplete tool protocol items remain protected.
- A stale revision, fingerprint, lifecycle, or tool-closure result produces stale/deferred; it never silently relocates selection.
- Token totals come only from snapshot metering. A model supplies recommendation labels and reasons only. `chars_only` never invents tokens.
- `estimated`, `scheduled`, and `applied` remain distinct. Applied savings need real Host rewrite evidence and actual removed counts.
- Persisted Cleaner records contain only IDs, digests, counts, reasons, and bounded sanitized summaries. No native request payload, transcript text, or adapter metadata is persisted.
- Cleaning is manual and archive-first. There is no background or default-all clean.

## Architecture

```text
CLI parser / renderer / TTY prompt
              |
              v
Context Cleaner workflow in @lightrsi/cleaner
              |
              +-- attribution, accounting, recommendation, plan/receipt store
              |
              v
Codex or Claude ContextCleanerHostBridge
              |
              v
existing Host-local schedule and rebase/overlay runtime
```

The CLI is a product composition root. It imports public Cleaner APIs and adapter bridge factories but never reads a journal, native message, response payload, or task registry. The feature package stays Host-independent and does not import products or adapters. Adapters retain native persistence and real rewrite behavior and do not know CLI syntax, TTY state, or prompts.

## Implemented public composition boundary

The shared feature already exposes `analyzeContextCleanSession` and
`createContextCleanerControlPlane`. The former reads the canonical snapshot
through `ContextCleanerHostBridge.readCleanSnapshot`, builds attribution and
recommendations, and persists an `analyzed` plan/receipt. The latter validates
the persisted frozen task targets before delegating `executeApprovedClean`,
`readCleanReceipt`, and `cancelCleanPlan` to the Host bridge.

The CLI consumes only this small product-facing interface:

```ts
interface CleanCommandBackend {
  analyze(sessionId: string): Promise<CleanPlanView>;
  readPlan(planId: string): Promise<CleanPlanView | undefined>;
  approve(planId: string, selectedTaskIds: string[]): Promise<CleanReceiptView>;
  readReceipt(planId: string): Promise<CleanReceiptView | undefined>;
  cancel(planId: string): Promise<CleanReceiptView>;
}
```

`createHostCleanCommandBackend` is the only CLI composition point. It resolves
the stored plan, derives the exact `itemIds` and `itemDigests` internally, and
passes them to the existing bridge. The CLI never receives those targets or
native Host state. Codex response-chain rebase and Claude overlay execution
remain responsible for actual rewrites and for applied receipts after upstream
success.

## CLI behavior

The TTY renderer shows the full effective-context denominator, selectable task rows, and non-selectable protected rows. Every selectable task starts unchecked. After selection, a separate confirmation defaults to No.

Without a TTY, `clean` writes an analyzed plan only. It prints plan ID, numbered selectable tasks, protected rows, and one exact follow-up command:

```bash
lightrsi <host> clean --plan <plan-id> --select <task-id,...>
```

`--plan --select` is explicit user approval, not a default. `--status` renders estimated, scheduled, applied, and fallback values separately. `--cancel` leaves terminal plans unchanged and returns their terminal receipt.

## Command skill

Codex and Claude Code installers add `lightrsi-clean` and remove only known legacy cleaner bridge names. The generated skill may run `lightrsi <host> clean` when explicitly invoked, which is a non-interactive analysis-only flow. It may not add `--plan`, `--select`, or `--cancel`, confirm a plan, or parse output to invoke a follow-up command. Codex keeps `allow_implicit_invocation: false`; Claude keeps `disable-model-invocation: true`.

## Installation boundary

The source-checkout entrypoints `pnpm cleaner:install:codex` and
`pnpm cleaner:install:claude-code` are product/release orchestration only. They
build the shared CLI, recovery MCP, and selected adapter, then delegate all Host
configuration changes to the existing adapter installer. They do not implement
Cleaner analysis, selection, scheduling, or rewrite logic.

The adapter installer installs both the canonical CLI launcher and the
analysis-only `lightrsi-clean` command skill. On Windows it also writes `.cmd`
launchers; on Unix-like systems it retains executable links. A missing or stale
build is rejected before Host installation when `--skip-build` is used.

## Files and ownership

- `components/packages/features/cleaner/src/{orchestrator,recommendation,token-accounting,clean-*-store}.ts`: Host-independent analysis, recommendation fallback, and plan/receipt lifecycle orchestration.
- `components/adapters/{codex,claude-code}/src/context-cleaner/**`: canonical snapshots, Host schedules, and actual rewrites only.
- `components/products/cli/src/{clean,clean-renderer,clean-prompt}.ts`: canonical grammar, public DTO presentation, and TTY interaction only.
- `components/products/cli/src/hosts/{cleaner,codex,claude-code}.ts` and `dispatch.ts`: product composition and routing only.
- `components/adapters/shared/command-skill-bridge.ts`: constrained skill installation only.
- `scripts/install-cleaner.mjs`: cross-platform source build/install orchestration only.
- `components/adapters/shared/{cli-bin-install,host-cli-bin-install,windows-command-launcher}.ts`: cross-platform command launchers only.

## Acceptance tests

1. An analyzed plan accounts for all effective context and cannot select a protected or unknown task.
2. A stale selection and an incomplete tool pair cannot schedule a rewrite.
3. Codex and Claude expose metadata-only analysis; raw native payloads are absent from returned and persisted data.
4. TTY begins with every selectable task unchecked and refuses to schedule when confirmation is declined.
5. Non-TTY prints the full plan, numbered selectable task IDs, protected rows, and an explicit follow-up command without scheduling.
6. `--status` renders estimated, scheduled, applied, and fallback values separately; applied values require Host evidence.
7. Generated command skills invoke only analysis and cannot autonomously select, confirm, cancel, or follow up.
