# TokenPilot Preset

TokenPilot is the current public runtime preset inside LightRSI. It targets a practical long-running-session problem: prompt history grows, tool outputs accumulate, cache reuse becomes unstable, and shared sessions become increasingly expensive.

Within the current LightRSI runtime path, TokenPilot primarily addresses this through:

- stable-prefix rewriting
- observation reduction before large tool outputs poison later turns
- lifecycle-aware canonical-history eviction for longer shared-session workflows where the host supports it

The preset owns the verified composition contract, not the feature implementations. `components/packages/features/` remains reusable by future presets, while each host adapter explicitly declares its supported TokenPilot feature subset.

The preset also owns `TOKENPILOT_PRODUCT_SURFACE_IDENTITY`, which binds the TokenPilot display name, primary `/tokenpilot` command, and the existing `/lightrsi` and `/tp` compatibility aliases to the generic product-surface runtime.

## Where It Fits

Use the root [README.md](../../../README.md) for the fastest first-run path:

- `OpenClaw`
  - install the repo
  - install the plugin
  - open a `lightrsi/<model>` session
  - verify with `/lightrsi status`
- `Codex CLI`
  - install the adapter
  - trust hooks if Codex asks for review
  - open a new Codex session to trigger `SessionStart`
  - verify with `lightrsi codex doctor`
- `Claude Code`
  - install the adapter
  - open a new Claude Code session to trigger `SessionStart`
  - verify with `lightrsi claude-code doctor`

Use [components/README.md](../../README.md) if you want the framework-level component index before diving into TokenPilot-specific details.

Use this component README when you need TokenPilot-specific details:

- command surface
- package layout
- configuration reference
- runtime state layout
- debugging notes
- host integration boundary
- standalone CLI usage

For compatibility, the current OpenClaw adapter also accepts the `lightrsi` command and model namespace aliases in addition to the established `tokenpilot` ones.

## Component And Adapter Boundary

Within LightRSI, `TokenPilot` is a thin preset rather than the owner of shared packages or host adapters. It composes Stabilizer, Reduction, and Eviction.

In the current public repo:

- `components/packages/`
  - shared foundation and independently composable feature packages
- `components/adapters/openclaw/`
  - the current production host adapter for OpenClaw
- `components/adapters/codex/`
  - Codex CLI adapter with hook-based integration and local Responses proxy
- `components/adapters/claude-code/`
  - Claude Code adapter with gateway routing and MCP-backed recovery
- `components/products/cli/`
  - standalone `lightrsi` CLI surface for hosts without native slash commands
- `components/products/mcp/`
  - shared stdio MCP surface for internal archive recovery

Adapter development notes live in:

- [adapters/README.md](../../adapters/README.md)

This is the intended reuse boundary for additional host adapters and future presets.

## Component Layout

```text
components/
├── packages/
│   ├── foundation/       # Kernel, runtime, history, artifacts, host and surface infrastructure
│   └── features/         # Stabilizer, Reduction, Eviction, and Memory
├── presets/
│   └── tokenpilot/       # This preset: Stabilizer + Reduction + Eviction
├── adapters/             # OpenClaw, Codex, Claude Code, and compatibility bindings
└── products/             # Shared CLI and MCP surfaces
```

## Explicit Host Bindings

The preset exports a versioned host-binding contract from `src/host-binding.ts`. Current adapters bind it as follows:

| Adapter | Declared feature subset |
| :-- | :-- |
| OpenClaw | `stabilizer`, `reduction`, `eviction` |
| Codex | `stabilizer`, `reduction`, `eviction` |
| Claude Code | `stabilizer`, `reduction` |

Feature product-surface contributions are initialized through this binding. They no longer depend on importing a feature package for side effects.

Host state discovery is also adapter-owned. The shared CLI and Visual surface consume `ProductHostRegistration` records from the adapters, while the recovery MCP server declares its preset ownership as a host-neutral product.

## Host Integrations

TokenPilot is being structured as a reusable LightRSI component with host adapters, rather than as a permanently OpenClaw-only implementation.

Host integration index:

- [adapters/README.md](../../adapters/README.md)
- [HOSTS.md](../../adapters/HOSTS.md)

Supported host adapters:

- `OpenClaw`: production adapter with the broadest public feature set
- `Codex CLI`: adapter with stable-prefix, reduction, MCP recovery, report, doctor, and shared browser visual
  - installs by rerouting the active Codex provider through a local TokenPilot proxy, while preserving existing session history under the same provider name
  - first successful verification usually happens after hooks are trusted and a new Codex session triggers `SessionStart`
- `Claude Code`: adapter with gateway routing, stable-prefix, reduction, MCP recovery, report, doctor, and shared browser visual
  - first successful verification usually happens after a new Claude Code session triggers `SessionStart`

Shared product surfaces:

- `lightrsi visual`: standalone browser visual entrypoint with multi-host selection

Use [HOSTS.md](../../adapters/HOSTS.md) for the current capability matrix and host-specific boundaries.

## Runtime Commands

### Status And Report

```text
/tokenpilot status
/tokenpilot report
/tokenpilot doctor
/tokenpilot mode normal
/tokenpilot help
```

Standalone CLI equivalents:

```bash
lightrsi visual
lightrsi openclaw status
lightrsi openclaw report
lightrsi openclaw doctor
lightrsi openclaw visual
lightrsi openclaw mode normal
```

Current Codex CLI equivalents:

```bash
lightrsi codex status
lightrsi codex report
lightrsi codex doctor
lightrsi codex mode normal
lightrsi codex reduction status
lightrsi codex stabilizer target user
```

Recommended first-run order for Codex:

1. `npm --prefix components/adapters/codex run install:codex`
2. trust hooks in Codex if prompted
3. open a new Codex session
4. `lightrsi codex doctor`
5. `lightrsi codex status`
6. after a few turns, `lightrsi codex report`

Current Claude Code CLI equivalents:

```bash
lightrsi claude-code status
lightrsi claude-code report
lightrsi claude-code doctor
lightrsi claude-code visual
lightrsi claude-code mode normal
lightrsi claude-code reduction status
lightrsi claude-code stabilizer target developer
```

Recommended first-run order for Claude Code:

1. `npm --prefix components/adapters/claude-code run install:claude-code`
2. open a new Claude Code session
3. `lightrsi claude-code doctor`
4. `lightrsi claude-code status`
5. after a few turns, `lightrsi claude-code report`

Notes:

- `lightrsi visual` opens the shared browser visual surface and can switch hosts from the sidebar
- `lightrsi openclaw visual` remains the OpenClaw-scoped browser visual entrypoint
- `lightrsi codex visual` and `lightrsi claude-code visual` now open the shared browser visual preselected to that host and session

### Stabilizer

```text
/tokenpilot stabilizer on
/tokenpilot stabilizer off
/tokenpilot stabilizer target developer
/tokenpilot stabilizer target user
```

### Reduction

```text
/tokenpilot reduction on
/tokenpilot reduction off
/tokenpilot reduction mode balanced
/tokenpilot reduction pass toolPayloadTrim off
```

### Eviction

```text
/tokenpilot eviction on
/tokenpilot eviction off
```

Recommended default behavior:

- default install mode is `normal`
- keep `stabilizer` enabled in all modes
- enable `eviction` mainly for longer continuous-session workloads on hosts that expose it
- on Codex, use `conservative` or `normal`; `aggressive` is intentionally unavailable
- on Claude Code, use `conservative` or `normal`; `aggressive` is intentionally unavailable

### Runtime Modes

TokenPilot now exposes three user-facing runtime presets:

- `conservative`: stabilizer on, lighter reduction preset, eviction off
- `normal`: stabilizer on, balanced reduction preset, eviction off
- `aggressive`: stabilizer on, aggressive reduction preset, eviction on with task-state estimator on

Commands:

```text
/tokenpilot mode conservative
/tokenpilot mode normal
/tokenpilot mode aggressive
```

Codex currently supports only:

- `lightrsi codex mode conservative`
- `lightrsi codex mode normal`

Claude Code currently supports only:

- `lightrsi claude-code mode conservative`
- `lightrsi claude-code mode normal`

## Configuration

This section mixes three host surfaces:

- `OpenClaw`
  - plugin-style config under `~/.openclaw/openclaw.json`
- `Codex CLI`
  - runtime config under `~/.codex/tokenpilot.json`
- `Claude Code`
  - runtime config under `~/.claude/tokenpilot.json`

Not every key below applies to every host. For the current public adapters:

- `OpenClaw`
  - supports the broadest configuration surface, including eviction-related knobs
- `Codex CLI`
  - supports stabilizer, reduction, and opt-in estimator-driven response-chain eviction; public eviction controls remain unavailable
- `Claude Code`
  - supports stabilizer + reduction related config only

TokenPilot is configured through your OpenClaw plugin entry, typically in:

```text
~/.openclaw/openclaw.json
```

The Codex adapter uses a separate runtime config file, typically:

```text
~/.codex/tokenpilot.json
```

The Claude Code adapter uses its own runtime config file, typically:

```text
~/.claude/tokenpilot.json
```

Minimal shape:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "layered-context"
    },
    "entries": {
      "tokenpilot": {
        "enabled": true,
        "config": {
          "enabled": true,
          "proxyAutostart": true,
          "proxyPort": 17667,
          "stateDir": "~/.openclaw/tokenpilot-plugin-state",
          "modules": {
            "stabilizer": true,
            "policy": true,
            "reduction": true,
            "eviction": false
          },
          "hooks": {
            "beforeToolCall": true,
            "dynamicContextTarget": "developer"
          },
          "reduction": {
            "engine": "layered",
            "triggerMinChars": 2200,
            "maxToolChars": 1200
          }
        }
      }
    }
  }
}
```

### Shared Runtime Configuration

| Key | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `enabled` | `boolean` | `true` | Enable TokenPilot plugin hooks. |
| `proxyBaseUrl` | `string` | unset | OpenAI-compatible upstream base URL used by the embedded proxy. |
| `proxyApiKey` | `string` | unset | API key used with `proxyBaseUrl`. |
| `stateDir` | `string` | `~/.openclaw/tokenpilot-plugin-state` | Root directory for TokenPilot runtime state. |
| `proxyAutostart` | `boolean` | `true` after install | Whether the embedded responses proxy starts automatically. |
| `proxyPort` | `number` | `17667` | Local port used by the embedded proxy. |
| `hooks.beforeToolCall` | `boolean` | `true` after install | Enable before-tool-call safety/default injection. |
| `hooks.dynamicContextTarget` | `string` | `developer` | Where dynamic context is injected. Supported values: `developer`, `user`. |
| `modules.stabilizer` | `boolean` | `true` | Enable stable-prefix related runtime behavior. |
| `modules.reduction` | `boolean` | `true` | Enable observation reduction execution. |
| `reduction.engine` | `string` | `layered` | Reduction engine. Current public value is `layered`. |
| `reduction.triggerMinChars` | `number` | `2200` | Minimum chars before reduction candidate generation is triggered. |
| `reduction.maxToolChars` | `number` | `1200` | Target maximum chars for trimmed tool payloads. |
| `reduction.passes.readStateCompaction` | `boolean` | `true` | Compact stale or superseded read results before they bloat later context. |
| `reduction.passes.toolPayloadTrim` | `boolean` | `true` | Trim oversized tool payloads. |
| `reduction.passes.htmlSlimming` | `boolean` | `true` | Compact noisy HTML content. |
| `reduction.passes.execOutputTruncation` | `boolean` | `true` | Truncate long execution outputs. |
| `reduction.passes.agentsStartupOptimization` | `boolean` | `true` | Apply agent startup optimization pass. |
| `ux.details` | `boolean` | `false` | Show module-level details in TokenPilot report surfaces where supported. |

### OpenClaw-Oriented Advanced Configuration

The advanced keys below are primarily relevant to the current OpenClaw adapter. Codex CLI and Claude Code intentionally do not expose most of these controls in their public command surface today.

| Key | Type | Default | Description |
| :-- | :-- | :-- | :-- |
| `logLevel` | `string` | `info` | Plugin log verbosity. Supported values: `info`, `debug`. |
| `debugTapProviderTraffic` | `boolean` | `false` | Debug-only provider traffic tap. |
| `debugTapPath` | `string` | unset | Optional output path for tapped provider traffic. |
| `proxyMode.pureForward` | `boolean` | `false` | Disable proxy-side rewriting and only forward traffic. |
| `hooks.toolResultPersist` | `boolean` | `false` | Persist oversized tool results as external artifacts. |
| `reduction.passOptions.formatSlimming.enabled` | `boolean` | `true` | Enable lightweight formatting cleanup. |
| `reduction.passOptions.formatCleaning.enabled` | `boolean` | `true` | Enable additional formatting cleanup. |
| `reduction.passOptions.pathTruncation.enabled` | `boolean` | `true` | Enable path shortening. |
| `reduction.passOptions.imageDownsample.enabled` | `boolean` | `true` | Enable image downsampling. |
| `reduction.passOptions.lineNumberStrip.enabled` | `boolean` | `true` | Enable line-number removal for noisy reads. |
| `eviction.policy` | `string` | `noop` | Eviction policy. Supported values: `noop`, `lru`, `lfu`, `gdsf`, `model_scored`. |
| `eviction.maxCandidateBlocks` | `number` | `128` after install | Upper bound on eviction candidates. |
| `eviction.minBlockChars` | `number` | `256` after install | Minimum block size considered for eviction. |
| `eviction.replacementMode` | `string` | `pointer_stub` | How evicted content is replaced. Supported values: `pointer_stub`, `drop`. |
| `taskStateEstimator.requestTimeoutMs` | `number` | `60000` | Estimator request timeout. |
| `taskStateEstimator.completedSummaryMaxRawTurns` | `number` | `0` | Optional cap for raw turns before completed-task summaries are used. |
| `taskStateEstimator.evictionPromotionPolicy` | `string` | `fifo` | Promotion policy used in decoupled mode. |
| `taskStateEstimator.evictionPromotionHotTailSize` | `number` | `1` | Number of most-recent completed tasks kept hot before promotion. |
| `contextEngine.enabled` | `boolean` | `true` after install | Enable canonical-state context pruning logic. |
| `contextEngine.pruneThresholdChars` | `number` | `100000` | Prune older tool results when canonical chars exceed this threshold. |
| `contextEngine.keepRecentToolResults` | `number` | `5` | Number of recent tool results to keep unpruned. |
| `contextEngine.placeholder` | `string` | `[pruned]` | Placeholder used after canonical pruning. |
| `memory.enabled` | `boolean` | `false` | Enable procedural memory features. |
| `memory.autoDistill` | `boolean` | `false` | Distill evicted tasks into skills asynchronously. |
| `memory.distillerType` | `string` | `prompting` | Supported values: `prompting`, `autoskill`, `ctx2skill`. |
| `memory.batchSize` | `number` | `2` | Background distillation batch size. |
| `memory.topK` | `number` | `0` | Maximum number of retrieved skills injected per request. |
| `memory.injectAsSystemHint` | `boolean` | `false` | Inject retrieved skills as a system hint instead of a user-prefix. |

### Estimator Upstream Fallback

If you enable `taskStateEstimator`, you can either configure its `baseUrl`, `apiKey`, and `model` explicitly, or leave them unset and let TokenPilot fall back to the currently detected upstream provider and its first mirrored model.

Minimal example with upstream fallback:

```json
{
  "plugins": {
    "entries": {
      "tokenpilot": {
        "config": {
          "taskStateEstimator": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

### Mode-to-Parameter Mapping

The install script applies `normal` mode by default.

| Mode | `modules.stabilizer` | `modules.reduction` | `modules.eviction` | `eviction.enabled` | `taskStateEstimator.enabled` | `reduction.triggerMinChars` | `reduction.maxToolChars` | Reduction profile |
| :-- | :--: | :--: | :--: | :--: | :--: | --: | --: | :-- |
| `conservative` | on | on | off | off | off | `4000` | `1800` | only repeated-read dedup + tool payload trim + startup optimization |
| `normal` | on | on | off | off | off | `2200` | `1200` | full reduction defaults |
| `aggressive` | on | on | on | on | on | `1400` | `900` | full reduction defaults with eviction |

For the current public defaults:

- `normal` and `aggressive` both enable `htmlSlimming`, `execOutputTruncation`, `formatSlimming`, `formatCleaning`, `pathTruncation`, `imageDownsample`, and `lineNumberStrip`
- `conservative` leaves those extra cleanup passes off and keeps only the two most direct reduction passes plus startup optimization

## Runtime State

State layout depends on the host:

- `OpenClaw`
  - `$HOME/.openclaw/tokenpilot-plugin-state/tokenpilot/`
- `Codex CLI`
  - `$HOME/.codex/tokenpilot-state/tokenpilot/`
- `Claude Code`
  - `$HOME/.claude/tokenpilot-state/tokenpilot/`

Useful files include:

- `event-trace.jsonl`
- `ux-effects/latest.json`
- `ux-effects/sessions/<session>.json`
- `session-state/latest.json`

OpenClaw-specific runtime state additionally includes:

- `provider-traffic.jsonl`
- `response-root-state.json`
- `sessions/<logical>/turns.jsonl`

## Debugging

When a run looks invalid, start with:

```bash
OPENCLAW_CONFIG_PATH=$HOME/.openclaw/openclaw.json openclaw config validate
tail -n 100 $HOME/.openclaw/logs/gateway.log
rg 'stable_prefix_rewrite|proxy_before_call_rewrite|proxy_after_call_rewrite|tool_result_persist_applied' \
  $HOME/.openclaw/tokenpilot-plugin-state/task-state/trace.jsonl
```

Current OpenClaw adapter self-check:

```text
/tokenpilot doctor
```

More package-level adapter notes live in:

- [adapters/README.md](../../adapters/README.md)
- [adapters/openclaw/README.md](../../adapters/openclaw/README.md)
- [adapters/codex/README.md](../../adapters/codex/README.md)
- [adapters/claude-code/README.md](../../adapters/claude-code/README.md)
- [TokenPilot experiment repository](https://github.com/Xubqpanda/TokenPilot)
