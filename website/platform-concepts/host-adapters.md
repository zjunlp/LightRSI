# Host Adapters

A host adapter is the **integration layer** between an agent host and the LightRSI core runtime. It translates host-specific events, APIs, and configuration into the standardized format that plugins expect. OpenClaw, Codex, and Claude Code provide the full TokenPilot surfaces; DeepSeek Harness currently provides a narrower compatibility adapter.

## Why Adapters Exist

Agent hosts differ in:

- **Event models**: how they signal session start, message received, tool called, session end
- **Configuration**: where and how settings are stored (JSON, TOML, env vars)
- **Context APIs**: how the prompt/context is assembled and sent to the model
- **Hook systems**: how external code can intercept or modify behavior

The adapter abstracts these differences so plugins only deal with one consistent interface.

## Adapter Responsibilities

```text
┌────────────────────────────────────────────┐
│                Host Adapter                 │
├────────────────────────────────────────────┤
│  1. Event translation                      │
│     Host-specific events → standard events  │
├────────────────────────────────────────────┤
│  2. Configuration integration              │
│     Reads host config, merges with plugin   │
│     config, writes back when needed         │
├────────────────────────────────────────────┤
│  3. Context interception                    │
│     Hooks into the host's context pipeline  │
│     so plugins can read/modify context      │
├────────────────────────────────────────────┤
│  4. Proxy / Gateway                         │
│     When the host doesn't support native    │
│     hooks, the adapter runs a local proxy   │
├────────────────────────────────────────────┤
│  5. CLI surface                             │
│     Exposes host-specific commands through  │
│     the shared lightrsi CLI                │
└────────────────────────────────────────────┘
```

## Current Adapters

| Host | Adapter Location | Integration Style |
| :-- | :-- | :-- |
| OpenClaw | `components/adapters/openclaw/` | Native plugin slot + restart |
| Codex | `components/adapters/codex/` | Local proxy + hooks |
| Claude Code | `components/adapters/claude-code/` | Local gateway + MCP |
| DeepSeek Harness | `components/adapters/deepseek-harness/` | Cordis plugin + durable projection |

## Next

- [Host Compatibility](/hosts/compatibility) — which features work on which host
- [Adding a New Host](/host-adapter-development/adding-new-host) — build your own adapter
- [Adapter Architecture](/host-adapter-development/adapter-architecture) — deep dive
