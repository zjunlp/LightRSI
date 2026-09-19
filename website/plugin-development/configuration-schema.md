# Configuration Schema

No formal configuration schema specification exists. TokenPilot uses host-specific configuration files; DeepSeek Harness uses a Cordis profile patch.

| Host | Config Path |
| :-- | :-- |
| OpenClaw | `~/.openclaw/openclaw.json` (plugin entry within `plugins.entries.tokenpilot.config`) |
| Codex CLI | `~/.codex/tokenpilot.json` |
| Claude Code | `~/.claude/tokenpilot.json` |
| DeepSeek Harness | `tokenpilot-dsh` in the selected Harness profile's `cordis.patch.yml`; [fields and defaults](/hosts/deepseek-harness#configuration-reference) |

For TokenPilot-specific config keys and defaults, see the [TokenPilot Configuration Reference](/plugin-catalog/tokenpilot/configuration).

## Related Pages

- [TokenPilot Configuration Reference](/plugin-catalog/tokenpilot/configuration) — detailed TokenPilot config documentation
