# CLI Reference

The `lightrsi` CLI provides shared commands for OpenClaw, Codex, and Claude Code. DeepSeek Harness uses its native plugin interface and [`/tokenpilot-status`](/hosts/deepseek-harness#verify-in-a-session).

## Global Commands

Commands that work without specifying a host (uses the default host set by `lightrsi use`).

```bash
lightrsi report              # Latest session report across hosts
lightrsi visual              # Open visual inspector (shared, switchable)
lightrsi use <host>          # Set default host
lightrsi use <host> session <id>  # Pin default session
lightrsi context             # Show default host, pinned session, config
lightrsi --help              # Top-level help
```

## OpenClaw Commands

### In-Session (`/lightrsi`)

```text
/lightrsi status             # Current plugin and runtime status
/lightrsi report             # Session token, cache, and cost report
/lightrsi doctor             # Full integration self-check
/lightrsi visual             # Open visual inspector
/lightrsi mode <mode>        # Switch: conservative | normal | aggressive
/lightrsi stabilizer target <developer|user>
/lightrsi reduction mode <light|balanced>
/lightrsi eviction <on|off>
/lightrsi settings details <on|off>
/lightrsi help               # List all commands
```

### Standalone CLI

```bash
lightrsi openclaw status
lightrsi openclaw report
lightrsi openclaw doctor
lightrsi openclaw visual
lightrsi openclaw mode <mode>
lightrsi openclaw session <id> report
lightrsi openclaw stabilizer <on|off>
lightrsi openclaw stabilizer target <developer|user>
lightrsi openclaw reduction <on|off>
lightrsi openclaw reduction mode <light|balanced>
lightrsi openclaw reduction pass toolPayloadTrim <off>
lightrsi openclaw eviction <on|off>
lightrsi openclaw help
```

## Codex Commands

```bash
lightrsi codex status
lightrsi codex report
lightrsi codex doctor
lightrsi codex visual
lightrsi codex session <id> report
lightrsi codex mode <conservative|normal>
lightrsi codex stabilizer <on|off>
lightrsi codex stabilizer target <developer|user>
lightrsi codex reduction <on|off>
lightrsi codex reduction mode <light|balanced>
lightrsi codex reduction pass toolPayloadTrim <off>
lightrsi codex reduction status
lightrsi codex help
```

Manual proxy control:

```bash
tokenpilot-codex status
tokenpilot-codex start
```

## Claude Code Commands

```bash
lightrsi claude-code status
lightrsi claude-code report
lightrsi claude-code doctor
lightrsi claude-code visual
lightrsi claude-code session <id> report
lightrsi claude-code mode <conservative|normal>
lightrsi claude-code stabilizer <on|off>
lightrsi claude-code stabilizer target <developer|user>
lightrsi claude-code reduction <on|off>
lightrsi claude-code reduction mode <light|balanced>
lightrsi claude-code reduction pass toolPayloadTrim <off>
lightrsi claude-code reduction status
lightrsi claude-code help
```

## DeepSeek Harness Commands

Inside a DeepSeek Harness session:

```text
/tokenpilot-status
```

This read-only command reports estimator activity, eligible eviction work, scheduled or applied changes, and deferrals without creating a model turn. The adapter is registered by Cordis as `tokenpilot-dsh`; it does not use the shared `lightrsi` CLI.

See [DeepSeek Harness](/hosts/deepseek-harness) for plugin installation and configuration. The global CLI commands above apply to OpenClaw, Codex, and Claude Code.

## Context Cleaner Commands

Cleaner is available through the shared CLI for `openclaw`, `codex`, and `claude-code`:

```bash
lightrsi <host> clean
lightrsi <host> clean --session <session-id>
lightrsi <host> clean --plan <plan-id> --select <task-id-1>,<task-id-2>
lightrsi <host> clean --status <plan-id>
lightrsi <host> clean --cancel <plan-id>
```

Analysis does not rewrite context. A terminal may then open a selector; a non-TTY invocation prints the plan without approving it. The `--plan ... --select ...` command explicitly approves those task IDs. Status and cancellation do not rerun analysis, and cancellation cannot undo an applied clean.

| Host | In-host entry | Apply timing |
| :-- | :-- | :-- |
| OpenClaw | `/lightrsi clean`; use the same plan/select/status/cancel options | Successful explicit apply returns `applied` immediately |
| Codex | User-entered `!lightrsi-clean` terminal selector or installed `lightrsi-clean` MCP-form skill | Next eligible host request |
| Claude Code | Installed `lightrsi-clean` skill is analysis-only; approve with explicit plan and task IDs | Next eligible host request |
| DeepSeek Harness | No public Cleaner command in the current adapter | Not exposed |

For installation, interactive controls, protected tasks, and receipt meanings, see [Context Cleaner](/user-guide/context-cleaner).

## Next

- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — using the browser dashboard
- [Logs and Diagnostics](/user-guide/logs-and-diagnostics) — finding and reading logs
