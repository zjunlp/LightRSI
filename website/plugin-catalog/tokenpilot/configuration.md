# TokenPilot Configuration

TokenPilot settings control how aggressively it manages context. Configuration differs by host.

| Host | Configuration approach |
| :-- | :-- |
| OpenClaw | Runtime modes and individual feature settings below |
| Codex | Shared CLI settings; see [supported features](/hosts/codex) |
| Claude Code | Shared CLI settings; see [supported features](/hosts/claude-code) |
| DeepSeek Harness | Explicit profile configuration: master switch, persistent state, estimator, and eviction settings |

## DeepSeek Harness Configuration

The `tokenpilot-dsh` Cordis plugin is **disabled by default**. Supply a durable `stateDir` and configure the estimator and eviction settings before enabling it. It runs eviction before Harness native compaction by default and bypasses optimization failures so the agent can continue.

Use the [DeepSeek Harness configuration example and reference](/hosts/deepseek-harness#configure-and-enable). The runtime modes, stabilizer, reduction, and CLI settings below apply to the other host adapters, subject to their supported features.

## Core Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `enabled` | `true`, `false` | `true` | Master on/off switch |
| `mode` | `conservative`, `normal`, `aggressive` | `normal` | Preset that controls all sub-policies |
| `logLevel` | `debug`, `info`, `warn`, `error` | `info` | How much detail in logs |

## Mode Presets

Each mode is a preset that configures stabilizer, reduction, and eviction behavior:

| Mode | Stabilizer | Reduction | Eviction |
| :-- | :-- | :-- | :-- |
| `conservative` | On (developer target) | Light | Off |
| `normal` | On (developer target) | Balanced | Off |
| `aggressive` | On (user target) | Strong | On (earlier threshold) |

See [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) for detailed behavior.

## Stabilizer Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `stabilizer.enabled` | `true`, `false` | `true` | Enable stable-prefix rewriting |
| `stabilizer.target` | `developer`, `user` | `developer` | Which message role gets the dynamic content |

## Reduction Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `reduction.enabled` | `true`, `false` | `true` | Enable context reduction |
| `reduction.mode` | `light`, `balanced` | `balanced` | How aggressively to trim |
| `reduction.pass.toolPayloadTrim` | `true`, `false` | `true` | Enable tool output trimming |

## Eviction Settings

| Setting | Values | Default | Description |
| :-- | :-- | :-- | :-- |
| `eviction.enabled` | `true`, `false` | `false` (off by default) | Enable context eviction |
| `eviction.threshold` | Token count | Mode-dependent | When to start evicting |

## Changing Settings

### Via CLI

```bash
# Change mode (applies the preset)
lightrsi mode aggressive

# Toggle individual features
lightrsi stabilizer off
lightrsi reduction mode light
lightrsi eviction on
```

## Next

- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — understand each mode in detail
- [Stable Prefix](/plugin-catalog/tokenpilot/stable-prefix) — how stabilization works
- [CLI Reference](/user-guide/cli-reference) — all commands
