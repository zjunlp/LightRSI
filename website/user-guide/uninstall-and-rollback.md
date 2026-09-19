# Uninstall and Rollback

How to stop TokenPilot and restore your original configuration.

## Quick Rollback

The OpenClaw, Codex, and Claude Code installers create `.tokenpilot.bak` backups for the host configuration files they preserve. Restore the applicable backup to its original name.

## DeepSeek Harness

DeepSeek Harness uses its own Cordis profile installation. The `.tokenpilot.bak` workflow above does not apply. To stop the adapter's automatic eviction, set `eviction.enabled` to `false` in its profile configuration, or set the plugin's `enabled` to `false` to disable its eviction handler. Reload the configured profile. This stops future changes; it does not undo prior replacements. See [DeepSeek Harness configuration](/hosts/deepseek-harness#configure-and-enable).

## Next

- [Install LightRSI](/getting-started/install-lightrsi) — fresh install
- [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) — problems before uninstalling
