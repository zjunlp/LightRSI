# Managing Plugins

Plugins are the core unit of functionality in LightRSI. This page covers how to list and manage installed plugins.

## Host Management Interfaces

| Host | Entry point |
| :-- | :-- |
| OpenClaw | `lightrsi openclaw status` |
| Codex | `lightrsi codex status` |
| Claude Code | `lightrsi claude-code status` |
| DeepSeek Harness | `/tokenpilot-status` inside Harness; configure `tokenpilot-dsh` through its profile |

The default-host and session-pinning commands below apply to the three shared CLI hosts. For DeepSeek Harness, see [profile configuration](/hosts/deepseek-harness#configure-and-enable).

## List Installed Plugins

```bash
lightrsi status
```

Shows all installed plugins and their state.

## Switching the Default Host

```bash
lightrsi use openclaw
lightrsi use codex
lightrsi use claude-code
```

This sets the default host for hostless commands like `lightrsi report`.

## Pinning a Session

```bash
lightrsi use codex session <session-id>
```

Subsequent `lightrsi report` and `lightrsi visual` commands will target this session.

## Checking Current Context

```bash
lightrsi context
```

Shows:
- Current default host
- Pinned session ID
- Config target

## Next

- [Managing Plugins](/user-guide/managing-plugins)
- [Plugin Configuration](/user-guide/plugin-configuration)
- [CLI Reference](/user-guide/cli-reference)
