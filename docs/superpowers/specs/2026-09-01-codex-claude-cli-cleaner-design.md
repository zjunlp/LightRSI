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

## Shared workflow interface

`ContextCleanerHostBridge` gains the narrow metadata-only operation:

```ts
readCleanAnalysis(sessionId: string): Promise<ContextCleanHostAnalysis>
```

`ContextCleanHostAnalysis` contains a canonical `ContextCleanSnapshot`, optional `contextWindowTokens`, and one task evidence record per known task. It does not expose a registry or raw Host data. The feature workflow exposes:

```ts
analyze(params): Promise<ContextCleanPlan>
selectAndSchedule(params): Promise<ContextCleanReceipt>
readStatus(planId): Promise<ContextCleanPlanStatus>
cancel(planId): Promise<ContextCleanReceipt>
```

`analyze` builds a task breakdown from the snapshot, uses the existing recommendation provider/fallback, and persists an `analyzed` plan. It never schedules a rewrite. `selectAndSchedule` validates task IDs against the persisted plan and builds the complete frozen approval internally; CLI callers cannot submit item IDs or digests.

## Schedule transaction

The existing public `executeApprovedClean` bridge operation remains the adapter-facing entry point. Its shared control-plane implementation becomes an internal two-phase transaction:

```text
validate frozen approval and current snapshot
-> write Host-local schedule pointer
-> transition shared plan approved -> scheduled
```

If the local schedule write fails, the shared plan remains `approved`. The Host-local pointer has only plan/session/revision identity; it does not copy selected items, digests, raw payloads, or receipts. Existing Codex response-chain and Claude overlay runtimes continue to perform the actual rewrite and write applied receipts only after successful upstream acceptance.

## CLI behavior

The TTY renderer shows the full effective-context denominator, selectable task rows, and non-selectable protected rows. Every selectable task starts unchecked. After selection, a separate confirmation defaults to No.

Without a TTY, `clean` writes an analyzed plan only. It prints plan ID, numbered selectable tasks, protected rows, and one exact follow-up command:

```bash
lightrsi <host> clean --plan <plan-id> --select <task-id,...>
```

`--plan --select` is explicit user approval, not a default. `--status` renders estimated, scheduled, applied, and fallback values separately. `--cancel` leaves terminal plans unchanged and returns their terminal receipt.

## Command skill

Codex and Claude Code installers add `lightrsi-clean` and remove only known legacy cleaner bridge names. The generated skill may run `lightrsi <host> clean` when explicitly invoked, which is a non-interactive analysis-only flow. It may not add `--plan`, `--select`, or `--cancel`, confirm a plan, or parse output to invoke a follow-up command. Codex keeps `allow_implicit_invocation: false`; Claude keeps `disable-model-invocation: true`.

## Files and ownership

- `components/packages/features/cleaner/src/{analysis,clean-workflow,clean-control-plane}.ts`: Host-independent analysis and plan lifecycle orchestration.
- `components/adapters/{codex,claude-code}/src/context-cleaner/analysis.ts`: Host-native snapshot and registry evidence converted to the narrow shared analysis contract.
- `components/products/cli/src/{clean,clean-args,clean-renderer,clean-prompt}.ts`: canonical command parsing, presentation, and injected TTY interaction.
- `components/products/cli/src/hosts/{registry,codex,claude-code}.ts` and `dispatch.ts`: composition and routing only.
- `components/adapters/shared/command-skill-bridge.ts`: constrained skill installation only.

## Acceptance tests

1. An analyzed plan accounts for all effective context and cannot select a protected or unknown task.
2. A stale selection and an incomplete tool pair cannot schedule a rewrite.
3. A local schedule write failure does not create a shared `scheduled` plan.
4. Codex and Claude expose metadata-only analysis; raw native payloads are absent from returned and persisted data.
5. TTY begins with every selectable task unchecked and refuses to schedule when confirmation is declined.
6. Non-TTY prints a plan and explicit command but does not schedule.
7. Applied status reports Host evidence and actual savings, not estimates.
8. Generated command skills cannot autonomously select or confirm cleaning.
