# Adapter Architecture

Host adapters are the integration layer between a specific coding-agent host and TokenPilot.

## Current Adapters

From [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md):

| Host | Status | Integration Mode | Install Surface |
| :-- | :-- | :-- | :-- |
| OpenClaw | production | bundled plugin + embedded runtime | `pnpm component:install:tokenpilot:openclaw` or `npm --prefix components/adapters/openclaw run install:release` |
| Codex CLI | available | hooks + local Responses proxy + shared CLI | `npm --prefix components/adapters/codex run build` then `npm --prefix components/adapters/codex run install:codex` |
| Claude Code | available | gateway routing + observability hooks + shared CLI | `npm --prefix components/adapters/claude-code run build` then `npm --prefix components/adapters/claude-code run install:claude-code` |
| DeepSeek Harness | available | Cordis plugin + durable projection + compatibility smoke | `pnpm --filter @lightrsi/deepseek-harness-adapter compatibility:smoke -- --dsh-checkout=/absolute/path/to/deepseek-harness` |

## Adapter Responsibilities

From [adapters/README.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/README.md):

Keep these inside the adapter:
- Host install and uninstall flow
- Host config mutation
- Request / response hook wiring
- Session and transcript bridging
- Host-specific command registration
- Runtime bootstrap and doctor checks
- Host-owned path resolution

## Shared Packages

Host-agnostic logic lives in shared packages under `components/packages/`:

| Package | Role |
| :-- | :-- |
| `components/packages/foundation/host-adapter/` | Host abstraction contracts and envelope bridge helpers |
| `components/packages/foundation/kernel/` | Shared contracts, events, and runtime-facing types |
| `components/packages/foundation/runtime-core/` | Host-agnostic reduction, recovery, and archive primitives |
| `components/packages/{foundation,features}/**` | Policy, history, and memory logic |
| `components/packages/foundation/product-surface/` | Shared command semantics for the standalone CLI |

## Related Pages

- [Adapter Testing](./adapter-testing.md)
- [Adding a New Host](./adding-new-host.md)
- [Configuration Integration](./configuration-integration.md)
- [Hook and Proxy Integration](./hook-proxy-integration.md)
- [Adapter Playbook](https://github.com/zjunlp/LightRSI/blob/main/docs/adapter-playbook.md)
- [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md)
