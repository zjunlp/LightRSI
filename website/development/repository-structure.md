# Repository Structure

The LightRSI repository is organized around a reusable runtime platform, feature packages, presets, products, and host adapters.

```text
LightRSI/
├── components/
│   ├── adapters/                # Host-specific integration
│   │   ├── openclaw/            #   OpenClaw native plugin adapter
│   │   ├── codex/               #   Codex CLI proxy + hooks adapter
│   │   ├── claude-code/         #   Claude Code gateway + MCP adapter
│   │   └── deepseek-harness/    #   DeepSeek Harness Cordis adapter
│   ├── products/                # Shared user-facing entrypoints
│   │   ├── cli/                 #   Shared lightrsi CLI
│   │   └── mcp/                 #   Shared MCP recovery server
│   ├── presets/
│   │   └── tokenpilot/          # TokenPilot feature composition
│   └── packages/
│       ├── foundation/          # Contracts and host-neutral primitives
│       │   ├── kernel/
│       │   ├── runtime-core/
│       │   ├── host-adapter/
│       │   ├── history/
│       │   ├── artifact-store/
│       │   └── product-surface/
│       └── features/            # Reusable policy and feature modules
│           ├── stabilizer/
│           ├── reduction/
│           ├── eviction/
│           ├── cleaner/
│           └── memory/
├── docs/                        # Public acceptance and adapter notes
├── website/                     # Documentation site
├── figs/                        # README images
└── README.md
```

Benchmark tasks, runners, profiles, and analysis are maintained in the separate [TokenPilot experiment repository](https://github.com/Xubqpanda/TokenPilot).

## Key Directories

| Directory | Purpose |
| :-- | :-- |
| `components/packages/foundation/` | Contracts, history, runtime, and host-neutral primitives |
| `components/packages/features/` | Stabilization, reduction, eviction, cleaner, and memory policies |
| `components/presets/tokenpilot/` | TokenPilot feature composition and presentation identity |
| `components/adapters/` | Host-specific installation, bridging, and runtime integration |
| `components/products/cli/` | The `lightrsi` CLI |
| `components/products/mcp/` | Shared MCP recovery server |

## Workspace

The repository uses pnpm workspaces. See `pnpm-workspace.yaml` for the full list.

## Next

- [Local Development](/development/local-development)
- [Build and Test](/development/build-and-test)
- [Contributing](/development/contributing)
