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

## Log Locations

| Host | Log Location | Notes |
| :-- | :-- | :-- |
| OpenClaw | `~/.openclaw/logs/gateway.log` | Gateway log confirmed in source |

## Next

- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — common problems and solutions
- [Uninstall and Rollback](/user-guide/uninstall-and-rollback) — clean removal
