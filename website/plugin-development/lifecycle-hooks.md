# Lifecycle Hooks

TokenPilot implements host-specific lifecycle hooks through its adapters. The actual hooks available depend on the host:

| Host | Hooks Used |
| :-- | :-- |
| Codex CLI | `SessionStart`, `PreToolUse`, `PostToolUse` (registered in `hooks.json`) |
| Claude Code | `SessionStart` (auto-starts gateway) |

These are host-specific hook names used by TokenPilot adapters, not a universal lifecycle specification. No formal lifecycle hook specification exists for the platform.

The shared runtime logic lives in `components/packages/foundation/runtime-core/`, while the hook wiring lives in `components/adapters/<host>/src/`.

## Related Pages

- [Host-Independent Design](/plugin-development/host-independent-design) — keeping shared logic separate from host-specific hook wiring
- [Hook and Proxy Integration](/host-adapter-development/hook-proxy-integration)
- [Adapter Architecture](/host-adapter-development/adapter-architecture)
