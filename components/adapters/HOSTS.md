# TokenPilot Host Integrations

TokenPilot is now structured as a reusable LightRSI component with multiple host adapters. Shared runtime logic lives under `components/packages/` and `components/products/`, while host-specific install surfaces and runtime wiring live under `components/adapters/<host>/`.

## Adapter Inventory

| Host | Status | Integration Mode | Install Surface | Main Adapter Docs |
| :-- | :-- | :-- | :-- | :-- |
| `OpenClaw` | production | bundled plugin + embedded runtime | `pnpm component:install:tokenpilot:openclaw` or `npm --prefix components/adapters/openclaw run install:release` | [openclaw/README.md](./openclaw/README.md) |
| `Codex CLI` | available | hooks + local Responses proxy + shared CLI | `npm --prefix components/adapters/codex run build` then `npm --prefix components/adapters/codex run install:codex` | [codex/README.md](./codex/README.md) |
| `Claude Code` | available | gateway routing + observability hooks + shared CLI | `npm --prefix components/adapters/claude-code run build` then `npm --prefix components/adapters/claude-code run install:claude-code` | [claude-code/README.md](./claude-code/README.md) |
| `DeepSeek Harness` | available | Cordis plugin + durable projection | `pnpm --filter @lightrsi/deepseek-harness-adapter compatibility:smoke -- --dsh-checkout=/absolute/path/to/deepseek-harness` | [GUA-06](../../docs/acceptance/GUA-06.md) |

Each full TokenPilot host adapter binds the versioned preset explicitly. OpenClaw and Codex declare Stabilizer, Reduction, and Eviction; Claude Code currently declares Stabilizer and Reduction. DeepSeek Harness is a separate compatibility adapter with a narrower projection surface. The same adapter-owned product registrations are used by the shared CLI and browser Visual surface where applicable.

## Capability Matrix

Legend:

- `yes`: supported in the current public adapter
- `partial`: available, but intentionally narrower than the OpenClaw path
- `no`: not supported in the current public adapter

| Capability | OpenClaw | Codex CLI | Claude Code |
| :-- | :--: | :--: | :--: |
| Stable-prefix rewriting | yes | yes | yes |
| Before-call reduction | yes | yes | yes |
| Real MCP-backed `memory_fault_recover` | yes | yes | yes |
| Standalone `lightrsi <host> ...` CLI | yes | yes | yes |
| `status` / `doctor` / `report` | yes | yes | yes |
| `visual` | yes | yes | yes |
| `mode conservative` / `mode normal` | yes | yes | yes |
| `mode aggressive` | yes | no | no |
| Estimator-driven lifecycle eviction runtime | yes | yes | yes |
| Lifecycle eviction controls | yes | no | no |
| In-host slash commands | yes | no | no |
| Hook-based observability | partial | yes | yes |
| Local proxy / gateway runtime | yes | yes | yes |
| Session-state / ux-effects persistence | yes | yes | yes |

## Host Notes

### OpenClaw

- richest public adapter today
- supports the browser visual flow
- currently the only adapter with lifecycle eviction controls and `mode aggressive`

### Codex CLI

- uses Codex config mutation, hook registration, and a local OpenAI-compatible Responses proxy
- preserves the current active Codex provider name and reroutes that provider's `base_url` through the local proxy
- uses the standalone `lightrsi codex ...` CLI surface instead of in-host slash commands
- supports stable-prefix, reduction, opt-in estimator-driven response-chain eviction, report, doctor, browser visual, and real MCP recovery
- first successful verification usually comes after hooks are trusted and a new Codex session triggers `SessionStart`
- intentionally does not expose `settings`, `eviction`, or `mode aggressive`

### Claude Code

- uses local Anthropic-compatible gateway routing plus lightweight hooks for observability
- uses the standalone `lightrsi claude-code ...` CLI surface instead of in-host slash commands
- supports stable-prefix, reduction, report, doctor, browser visual, and real MCP recovery
- first successful verification usually comes after a new Claude Code session triggers `SessionStart`
- intentionally does not expose `settings`, `eviction`, or `mode aggressive`

### DeepSeek Harness

- uses a Cordis plugin adapter with durable session/event projection
- supports TokenPilot status projection and compatibility smoke verification
- canonical surface eviction remains opt-in and is guarded by estimator, registry, safety, and revision checks

### Shared Visual Surface

- `lightrsi visual` now provides a standalone browser visual entrypoint
- the shared visual can switch between `openclaw`, `codex`, and `claude-code` hosts
- today, the browser visual is backed by snapshot data; OpenClaw still has the richest dataset, while Codex and Claude Code now route their `visual` commands into the shared browser surface

## Boundary

The intended split is:

- `kernel`
  - shared contracts, events, and runtime-facing types
- `runtime-core`
  - host-agnostic reduction, recovery, and archive primitives
- `components/packages/foundation/*` and `components/packages/features/*`
  - policy, history, and memory logic
- host adapter
  - host config wiring
  - session / transcript bridge
  - command and install surface
  - runtime bootstrap and doctor checks

In directory form, that means:

- `components/packages/*`
  - reusable component logic
- `components/products/*`
  - shared product surfaces such as the standalone CLI and MCP server
- `components/adapters/<host>`
  - host-specific integration layer

General adapter development guidance lives in:

- [README.md](./README.md)

## Adapter Checklist

When adding a new host adapter, cover these surfaces explicitly:

- install surface
  - where the host is configured
  - what file or plugin entry is touched
  - how to enable and disable it
- session bridge
  - how session ids, turn ids, and workspace paths are resolved
- transcript bridge
  - how raw host messages are read or reconstructed
- request / response hook model
  - before-call rewriting
  - after-call reduction
  - tool-result persistence
  - streaming vs non-streaming behavior
- state roots
  - state dir
  - namespace dir
  - archive dir
- control surface
  - commands, visualizations, status, and debugging entrypoints

## Ongoing Cleanup

Current cleanup priorities are:

1. keep pushing remaining OpenClaw-specific assumptions down into the OpenClaw adapter
2. continue sharing state, observability, and CLI glue across Codex and Claude Code
3. strengthen install / doctor / report / visual parity where the host surface allows it
