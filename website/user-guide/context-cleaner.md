# Context Cleaner

Context Cleaner is LightRSI's product for reviewing and cleaning a session's context **by task**. It shows task descriptions, context usage, recommendations, and protected content so you can choose which eligible tasks to remove from the context carried forward to the model.

In the project structure, LightRSI is the runtime and platform, TokenPilot is a context-management preset, and Cleaner is a user-facing product. Cleaner entrypoints are supplied through the shared CLI, MCP, and host integrations described below.

Analysis does not rewrite context. Cleaning requires your explicit task selection. Recommendations do not select tasks for you, and protected tasks cannot be selected.

<details>
<summary>Watch the Codex task-selection demo (GIF, approximately 3 MB)</summary>

<img src="/images/context-cleaner.gif" alt="Codex Context Cleaner task selection" loading="lazy" decoding="async" width="2000" height="1629" />

</details>

## Cleaner, Reduction, and Automatic Eviction

| Capability | How it is used |
| :-- | :-- |
| Context Cleaner | You inspect a plan, choose eligible tasks, and approve a specific clean |
| Context Reduction | Runtime policies trim oversized or noisy payloads |
| Automatic Context Eviction | Host runtime policies decide when eligible older context can be evicted |

Cleaner reuses task lifecycle and host rewrite capabilities. It is not a command to rerun reduction, and selecting tasks is not the same as enabling an automatic eviction mode.

## Supported Hosts

| Host | User entry point | When an approved clean takes effect |
| :-- | :-- | :-- |
| OpenClaw | `/lightrsi clean` or `lightrsi openclaw clean --session <session-id>` | A successful explicit apply returns `applied` immediately |
| Codex | `!lightrsi-clean` for the terminal selector; the installed `lightrsi-clean` skill for the MCP form; or `lightrsi codex clean` | Selection is scheduled for the next eligible host request |
| Claude Code | Installed `lightrsi-clean` analysis skill or `lightrsi claude-code clean` | Selection is scheduled for the next eligible host request |
| DeepSeek Harness | No public Cleaner command is wired into the current adapter entrypoint | Its automatic eviction and `/tokenpilot-status` are separate features |

For OpenClaw, Codex, and Claude Code, the shared terminal CLI supports analysis, explicit selection, status, and cancellation. The host-specific interfaces differ as described below.

## Install

Run these commands from a LightRSI checkout after installing workspace dependencies with `corepack pnpm install`:

::: code-group
```bash [OpenClaw]
# Shared CLI, if you want to use the terminal commands
pnpm lightrsi:build
pnpm lightrsi:install

# Native OpenClaw plugin
pnpm component:install:tokenpilot:openclaw
```

```bash [Codex]
corepack pnpm cleaner:install:codex
```

```bash [Claude Code]
corepack pnpm cleaner:install:claude-code
```
:::

The Codex and Claude Code installers build the shared CLI, recovery MCP, and selected adapter, then install the Cleaner command skills. Codex also registers the Cleaner MCP server used for its task-selection form. DeepSeek Harness has no equivalent public Cleaner installer in this workflow.

For the OpenClaw shared CLI, use a Bash environment and ensure `~/.local/bin` (or your `LIGHTRSI_BIN_DIR`) is on `PATH`. Codex and Claude Code installers use `~/.local/bin` by default on Linux/macOS; on Windows they create command launchers and use the npm command directory when it is already on `PATH`.

Start a session through the installed adapter so Cleaner has session context to inspect. See [Install Your First Plugin](/getting-started/install-first-plugin) for host setup and custom configuration paths. Cleaner also needs task lifecycle information to identify eligible tasks; installation alone does not guarantee selectable tasks.

### Task Classification and Recommendations

| Entry point | Source of task information and recommendations |
| :-- | :-- |
| OpenClaw native `/lightrsi clean` | Host-managed model completion for pending task classification and recommendations; explicitly configured estimator fallback on older hosts |
| OpenClaw standalone CLI | Existing task registry plus the configured `taskStateEstimator` recommendation provider |
| Codex | Task registry, with estimator-backed refresh during Cleaner analysis; recommendations use the resolved estimator connection |
| Claude Code | Task registry populated on the gateway request path; Cleaner recommendations use `taskStateEstimator` settings |

For Codex and Claude Code, the explicit estimator configuration is in `~/.codex/tokenpilot.json` or `~/.claude/tokenpilot.json` respectively (or your configured alternative path). Merge this block into the existing configuration, replacing the connection placeholders:

```json
{
  "taskStateEstimator": {
    "enabled": true,
    "baseUrl": "https://your-estimator-endpoint/v1",
    "apiKey": "YOUR_ESTIMATOR_API_KEY",
    "model": "your-estimator-model"
  }
}
```

Use local configuration for credentials, not a checked-in file. This provides model access for task evidence and recommendations; user approval is still required for Cleaner. In Claude Code, task classification runs on ordinary gateway requests, so analyze after the session has produced task lifecycle evidence. A missing provider or incomplete task evidence must not be worked around by selecting protected tasks.

## 1. Analyze the Intended Session

Run the command for your host:

::: code-group
```bash [OpenClaw]
lightrsi openclaw clean --session <session-id>
```

```bash [Codex]
lightrsi codex clean
```

```bash [Claude Code]
lightrsi claude-code clean
```
:::

Replace placeholders with actual IDs. Use `--session <session-id>` with any of these hosts to target a specific session. Without an explicit ID, the CLI resolves a session from its host context; check the displayed **Host/session** before approving anything. Do not assume it is the conversation you intended when several sessions exist.

Analysis stores a plan and a receipt, and may use model-assisted task classification or recommendations, but does not apply a context rewrite. In an interactive terminal it then opens the task selector. Without a TTY it prints the plan, selectable task IDs, and an explicit apply-command hint without scheduling a clean.

## 2. Review and Select Tasks

The plan includes its ID, host/session, context usage, protected and unassigned context, task descriptions, size, recommendations, and reason codes.

| Plan field | How to read it |
| :-- | :-- |
| `clean` | Recommended for cleaning, subject to selectability and your approval |
| `keep` | Recommended to retain; review the reason and whether it is selectable |
| `protected` / `[-]` | Cannot be selected |
| `[ ]` / `[x]` | Unselected / selected task in the terminal selector |
| `exact`, `estimated`, `chars_only` | Accounting mode; character counts are not token counts |

Current OpenClaw and Claude Code Cleaner snapshots use character counts. Codex uses precise tokenizer counts when available and otherwise falls back to characters. A dash in the share column is not zero usage, and a context-window percentage is shown only when the required token and window data are available.

For the raw terminal selector, **Up/Down** moves between selectable tasks, **Space** toggles a task, and **Enter submits the checked selection**. Tasks start unchecked. `q` or Escape cancels; Ctrl+C interrupts and cancels the plan. Submitting no selected tasks applies no change. These keys describe the terminal selector, not a host-rendered MCP form.

To approve a plan explicitly, copy the complete plan and task IDs from the analysis:

```bash
lightrsi <host> clean --plan <plan-id> --select <task-id-1>,<task-id-2>
```

Here `<host>` is `openclaw`, `codex`, or `claude-code`. This command is the approval itself; it does not open another task-selection prompt. Use task IDs from selectable rows, not task labels, row numbers, or a shortened session ID.

## 3. Check the Result

```bash
lightrsi <host> clean --status <plan-id>
```

| Receipt status | Meaning |
| :-- | :-- |
| `analyzed` | A plan exists; no selection has been approved |
| `approved` | The selected tasks have been approved; this alone is not proof of application |
| `scheduled` | Waiting for the host to execute the approved clean |
| `applied` | The host has recorded application evidence |
| `stale` | The plan no longer passes validation; analyze again and review a new selection |
| `cancelled` | The plan has been cancelled |
| `failed` | The clean failed; inspect its reasons and fallback information |

For Codex and Claude Code, a `scheduled` receipt is expected immediately after approval. Resume the same session with a normal follow-up request, then check the receipt again. The request used to submit the selection is not itself proof that the clean has been applied. OpenClaw's successful explicit apply returns an `applied` receipt immediately.

Keep **estimated**, **scheduled**, and **applied** savings separate. A plan estimate or pending schedule does not establish that context was removed, and Cleaner context-size accounting is not a measurement of provider billing savings.

## Cancel a Pending Plan

```bash
lightrsi <host> clean --cancel <plan-id>
```

Read the returned receipt: cancellation is not an undo command for an already applied clean. If execution has already completed, cancelling cannot restore the prior context. Analysis, selection, status, and cancellation always refer to a specific plan; status and cancellation do not rerun analysis.

## Host-Specific Interfaces

### OpenClaw

Inside an OpenClaw conversation:

```text
/lightrsi clean
/lightrsi clean --session <session-id>
/lightrsi clean --plan <plan-id> --select <task-id-1>,<task-id-2>
/lightrsi clean --status <plan-id>
/lightrsi clean --cancel <plan-id>
```

The first command analyzes the mapped current session; provide a session ID if no mapping is available. The native analysis command does not apply a rewrite. `/tokenpilot clean` and `/tp clean` are aliases.

The native command can classify pending turns and generate recommendations through OpenClaw's host-managed model completion service. Older hosts without that service fall back to explicitly configured `taskStateEstimator` settings. Do not assume the standalone terminal entrypoint has the same host-managed model access. OpenClaw's canonical eviction backend archives task content before committing the rewrite, which replaces the selected content with a pointer stub or drops it according to the replacement mode. This archive does not make Cleaner cancellation an undo operation.

### Codex

For the terminal selector, type the shell escape yourself inside Codex:

```text
!lightrsi-clean
```

The equivalent standalone launcher is `lightrsi-clean`; the explicit host CLI is `lightrsi codex clean`. On Windows, the terminal selector uses the current terminal's modal console buffer and restores it on exit.

For the host-rendered form, explicitly invoke the installed `lightrsi-clean` skill (documented as `$lightrsi-clean` in the Codex adapter README). It calls the Cleaner MCP tool, which analyzes and collects the user's selection in one invocation. The host owns the form's controls. Protected tasks appear in the plan text but are not selectable form fields. Cancelling or accepting an empty selection schedules nothing.

Both paths schedule an accepted selection for a later host request, where Codex performs a response-chain rebase. The explicit `lightrsi-clean-status`, `lightrsi-clean-apply`, and `lightrsi-clean-cancel` skills require the complete plan ID; apply also requires the complete selected task IDs supplied by the user.

### Claude Code

The installed `lightrsi-clean` skill performs **analysis only**. It must not select tasks, confirm a prompt, or run the apply command for you. Review the output, then personally supply the plan and task IDs for the explicit apply flow, or use `lightrsi claude-code clean` in an interactive terminal.

The shared installer also provides the explicit status, apply, and cancel skills. These require the complete plan ID, and apply requires the exact task IDs you choose. An accepted selection is scheduled; the gateway applies an archived request overlay on a subsequent eligible request and records the result. This does not promise an immediate change to the currently running request.

### DeepSeek Harness

The repository contains Cleaner backend modules for Harness, but its current Cordis entrypoint and command registration do not expose a public Cleaner workflow. Do not use `lightrsi deepseek-harness clean` or assume `/tokenpilot-status` can analyze, approve, or cancel Cleaner plans. See [DeepSeek Harness](/hosts/deepseek-harness) for its implemented automatic eviction and status workflow.

## Protected Context and Recommendations

Cleaner protects system/developer instructions, current or active work, unresolved tasks, ambiguous task attribution, and unsafe tool-call/result relationships. Application also depends on the host's archive and rewrite checks. Targets are revalidated against current host context before application; approval does not bypass those checks.

Task descriptions and recommendations help you understand the plan. They do not choose arbitrary text ranges, override safety checks, or authorize a clean. If the recommendation provider is unavailable or fails, the shared fallback keeps deterministic accounting and conservative keep/protected recommendations instead of inventing a selection. Missing task lifecycle evidence can leave no selectable tasks.

## Troubleshooting

| Symptom | What to do |
| :-- | :-- |
| No session or snapshot is available | Start a session through the installed adapter, verify the host/session shown, and pass `--session` when needed |
| Everything is protected or unassigned | Check task lifecycle information and host estimator setup; active or uncertain tasks must remain protected |
| No interactive selector | A non-TTY invocation is analysis-only. Use a real terminal, the supported Codex MCP form, or the explicit plan/selection command |
| Plan is `stale` | Analyze the current session again and review the new plan; do not reuse old task IDs without checking |
| Receipt stays `scheduled` | Continue the same Codex/Claude Code session, then query the receipt; inspect reasons if application is deferred |
| Counts are in characters | The snapshot has no supported precise token counts; do not interpret characters as tokens |
| Codex form is unavailable | Check `lightrsi codex doctor`; recovery MCP and Cleaner MCP health are reported separately. The terminal selector is a separate entrypoint |
| Claude Code skill only prints analysis | This is intentional. Task selection and approval require your explicit action |

## Implementation References

- [Project README](https://github.com/zjunlp/LightRSI/blob/main/README.md#products) — product and installation entrypoints
- [OpenClaw adapter](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/openclaw/README.md) and [Codex adapter](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/codex/README.md#cleaner-selection-in-codex) — native interfaces
- [Shared CLI controller](https://github.com/zjunlp/LightRSI/blob/main/components/products/cli/src/clean.ts) and [command skills](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/shared/command-skill-bridge.ts) — selection, approval, and command behavior
- [Cleaner contracts](https://github.com/zjunlp/LightRSI/blob/main/components/packages/features/cleaner/src/contracts.ts) — accounting and receipt states
- [Codex control service](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/codex/src/context-cleaner/control-service.ts) and [Claude Code control service](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/claude-code/src/context-cleaner/control-service.ts) — estimator and recommendation configuration
