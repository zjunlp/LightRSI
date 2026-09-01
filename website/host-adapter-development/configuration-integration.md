# Configuration Integration

## Config Files by Host

From source:

| Host | Config Location | Purpose |
| :-- | :-- | :-- |
| **OpenClaw** | Plugin entry in `~/.openclaw/openclaw.json` | TokenPilot registered as a plugin within OpenClaw configuration |
| **Codex CLI** | `~/.codex/tokenpilot.json` (runtime config) + `~/.codex/hooks.json` (hook registration) | `tokenpilot.json` stores provider config and runtime settings. `hooks.json` registers hooks (`SessionStart`, `PreToolUse`, `PostToolUse`). Host's `config.toml` modified to reroute provider `base_url` to local proxy |
| **Claude Code** | `~/.claude/tokenpilot.json` (runtime config) + `~/.claude/settings.json` (gateway routing) + `~/.claude/.claude.json` (MCP registration) | `tokenpilot.json` stores runtime config. `settings.json` updated for gateway routing. `.claude.json` registers `tokenpilot_memory_fault_recover` MCP server |

## Environment Variables

From source:

| Adapter | Environment Variable | Default Path |
| :-- | :-- | :-- |
| OpenClaw | `LIGHTRSI_OPENCLAW_HOME` | `~/.openclaw/` |
| OpenClaw | `OPENCLAW_CONFIG_PATH` | `~/.openclaw/openclaw.json` |
| Codex | `CODEX_CONFIG_PATH` | `~/.codex/config.toml` |
| Codex | `CODEX_HOOKS_CONFIG_PATH` | `~/.codex/hooks.json` |
| Codex | `TOKENPILOT_CODEX_CONFIG` | `~/.codex/tokenpilot.json` |
| Claude Code | `CLAUDE_CODE_SETTINGS_PATH` | `~/.claude/settings.json` |
| Claude Code | `CLAUDE_CODE_MCP_CONFIG_PATH` | `~/.claude/.claude.json` |
| Claude Code | `TOKENPILOT_CLAUDE_CODE_CONFIG` | `~/.claude/tokenpilot.json` |

## Backup Strategy

Before modifying existing host config files, the installer creates `.tokenpilot.bak` backups. This applies to Codex (`~/.codex/config.toml`) and Claude Code (`~/.claude/settings.json`, `~/.claude/.claude.json`).

## Related Pages

- [Adapter Architecture](./adapter-architecture.md)
- [Adding a New Host](./adding-new-host.md)
- [Hook and Proxy Integration](./hook-proxy-integration.md)
- [TokenPilot Configuration](https://github.com/zjunlp/LightRSI/blob/main/README.md)
