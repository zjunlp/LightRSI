# Plugin Directory Structure

The TokenPilot reference component is composed from shared LightRSI packages, a preset, products, and host adapters.

## Top-Level Layout

```text
components/
├── adapters/
│   ├── openclaw/         # OpenClaw adapter, hooks, commands, embedded proxy
│   ├── codex/            # Codex CLI adapter, hooks, provider install, local proxy
│   ├── claude-code/      # Claude Code adapter, gateway routing, MCP recovery
│   └── deepseek-harness/ # DeepSeek Harness Cordis adapter
├── products/
│   ├── cli/              # Shared lightrsi CLI surface
│   └── mcp/              # Shared memory_fault_recover MCP server
├── presets/
│   └── tokenpilot/       # TokenPilot feature composition
└── packages/
    ├── foundation/      # Contracts, history, runtime, and host-neutral primitives
    └── features/        # Stabilizer, reduction, eviction, cleaner, and memory
```

## Directory Purpose

| Directory | Purpose |
| :-- | :-- |
| `packages/foundation/kernel/` | Shared contracts, events, and runtime-facing types |
| `packages/foundation/runtime-core/` | Host-agnostic runtime engine and reduction pipeline |
| `packages/foundation/history/` | Canonical state, anchors, and lifecycle bookkeeping |
| `packages/foundation/host-adapter/` | Shared host contracts and path-resolution interfaces |
| `packages/foundation/product-surface/` | Shared user-facing command actions and product semantics |
| `packages/features/eviction/` | Reduction and eviction analysis / policy logic |
| `packages/features/memory/` | Experimental memory layer still under active development |
| `presets/tokenpilot/` | TokenPilot composition and presentation identity |

### `adapters/` — Host-Specific Integration

| Directory | Purpose |
| :-- | :-- |
| `adapters/<host>/` | Host install/uninstall flow, config mutation, request/response hooks, session/transcript bridging, host-specific commands, runtime bootstrap, and doctor checks |

### `products/` — Shared Entrypoints

| Directory | Purpose |
| :-- | :-- |
| `products/cli/` | Standalone CLI surface for hosts without native slash commands |
| `products/mcp/` | Shared MCP server surface, including `memory_fault_recover` |

The adapter internal structure is described in [adapters/README.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/README.md).

## Related Pages

- [Runtime API](/plugin-development/runtime-api) — the shared packages and their public surfaces
