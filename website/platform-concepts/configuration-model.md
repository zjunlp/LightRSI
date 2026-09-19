# Configuration Model

## Where Configuration Lives

| Host | Config File | Plugin Config |
| :-- | :-- | :-- |
| OpenClaw | `~/.openclaw/openclaw.json` | Inside the host config |
| Codex | `~/.codex/tokenpilot.json` | Separate plugin config file |
| Claude Code | `~/.claude/tokenpilot.json` | Separate plugin config file |
| DeepSeek Harness | Harness profile's `cordis.patch.yml` | `tokenpilot-dsh` config; [setup and defaults](/hosts/deepseek-harness#configure-and-enable) |

## Environment Variables

Adapters use environment variables for non-default paths:

| Variable | Purpose | Host |
| :-- | :-- | :-- |
| `LIGHTRSI_OPENCLAW_HOME` | Custom OpenClaw home dir | OpenClaw |
| `OPENCLAW_CONFIG_PATH` | Custom config path | OpenClaw |
| `CODEX_CONFIG_PATH` | Custom config.toml path | Codex |
| `CODEX_HOOKS_CONFIG_PATH` | Custom hooks.json path | Codex |
| `TOKENPILOT_CODEX_CONFIG` | Custom tokenpilot.json path | Codex |
| `CLAUDE_CODE_SETTINGS_PATH` | Custom settings.json path | Claude Code |
| `CLAUDE_CODE_MCP_CONFIG_PATH` | Custom .claude.json path | Claude Code |
| `TOKENPILOT_CLAUDE_CODE_CONFIG` | Custom tokenpilot.json path | Claude Code |

## Next

- [TokenPilot Configuration](/plugin-catalog/tokenpilot/configuration) — TokenPilot-specific settings
