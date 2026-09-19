# Plugin Configuration

Each plugin exposes configuration that can be tuned for your needs.

## Changing Configuration

### Via CLI

These controls apply to the shared CLI hosts, with feature availability shown in [Host Compatibility](/hosts/compatibility). DeepSeek Harness is configured through its Harness profile.

```bash
# Mode presets
lightrsi mode conservative
lightrsi mode normal
lightrsi mode aggressive

# Individual settings
lightrsi stabilizer target developer
lightrsi reduction mode balanced
lightrsi eviction on
```

### Via Config File

Edit the plugin config file directly:

| Host | Configuration |
| :-- | :-- |
| OpenClaw | `~/.openclaw/openclaw.json` |
| Codex | `~/.codex/tokenpilot.json` |
| Claude Code | `~/.claude/tokenpilot.json` |
| DeepSeek Harness | `tokenpilot-dsh` in the selected Harness profile's `cordis.patch.yml` |

DeepSeek Harness is disabled by default. Configure its persistent `stateDir`, estimator, and eviction settings before enabling it. See the [configuration example](/hosts/deepseek-harness#configure-and-enable).

## Next

- [TokenPilot Configuration](/plugin-catalog/tokenpilot/configuration) — TokenPilot-specific settings
- [Configuration Model](/platform-concepts/configuration-model) — platform-level config
