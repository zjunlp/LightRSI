# Logs and Diagnostics

How to find logs and use diagnostic tools.

## Quick Diagnostic Commands

For OpenClaw, Codex, and Claude Code, start with the shared CLI:

```bash
lightrsi doctor    # Integration health check
lightrsi status    # Current state
lightrsi report    # Session metrics
```

These report integration health, runtime state, and session metrics for the selected CLI host.

### DeepSeek Harness

Inside a Harness session, run:

```text
/tokenpilot-status
```

This read-only command reports estimator activity, scheduling, application, and deferrals. See [DeepSeek Harness troubleshooting](/hosts/deepseek-harness#troubleshooting) for configuration checks and debug output. Do not use the shared CLI `doctor` command for this adapter.

## Context Cleaner Receipts

For `openclaw`, `codex`, or `claude-code`, inspect an exact plan without rerunning analysis:

```bash
lightrsi <host> clean --status <plan-id>
```

Check the receipt's status, reasons, deferred tasks, and fallback information. A scheduled clean is not yet an applied clean. Codex and Claude Code's reports also expose Cleaner savings and fallback information; Codex doctor distinguishes Cleaner MCP health from recovery MCP health. See [Context Cleaner](/user-guide/context-cleaner#_3-check-the-result) for state meanings and apply timing.

## Log Locations

| Host | Log Location | Notes |
| :-- | :-- | :-- |
| OpenClaw | `~/.openclaw/logs/gateway.log` | Gateway log confirmed in source |

## Next

- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — common problems and solutions
- [Uninstall and Rollback](/user-guide/uninstall-and-rollback) — clean removal
