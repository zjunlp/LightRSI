# Plugin Lifecycle

No formal plugin lifecycle specification exists. TokenPilot uses host-specific mechanisms:

- **OpenClaw**: native plugin slot with bundled runtime
- **Codex CLI**: hooks (`SessionStart`, `PreToolUse`, `PostToolUse`) via `hooks.json`
- **Claude Code**: `SessionStart` hook + gateway + MCP recovery

## Next

- [Configuration Model](/platform-concepts/configuration-model) — how plugin config works
- [Runtime API](/plugin-development/runtime-api) — the plugin programming interface
