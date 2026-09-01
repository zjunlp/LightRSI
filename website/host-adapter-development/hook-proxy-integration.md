# Hook and Proxy Integration

TokenPilot uses three integration approaches across its host adapters.

## Integration Approaches

### Proxy + Hooks (Codex CLI)

From [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md): uses Codex config mutation, hook registration, and a local OpenAI-compatible Responses proxy. Preserves the current active Codex provider name and reroutes that provider's `base_url` through the local proxy. Hooks registered: `SessionStart`, `PreToolUse`, `PostToolUse`.

### Gateway + MCP + SessionStart (Claude Code)

From [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md): uses local Anthropic-compatible gateway routing plus lightweight hooks for observability. A `SessionStart` hook auto-starts the local gateway. The `tokenpilot_memory_fault_recover` MCP server is registered for recovery.

### Native Plugin Slot (OpenClaw)

From [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md): bundled plugin with embedded runtime. The host delivers events directly to the plugin without an external proxy or gateway. Supports in-host slash commands, lifecycle eviction controls, and `mode aggressive`.

## Related Pages

- [Adapter Architecture](./adapter-architecture.md)
- [Adding a New Host](./adding-new-host.md)
- [Configuration Integration](./configuration-integration.md)
- [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md)
