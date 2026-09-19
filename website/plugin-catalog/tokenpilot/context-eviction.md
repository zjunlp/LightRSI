# Context Eviction

Context eviction provides **lifecycle-aware pruning** of old context in longer shared-session workflows.

OpenClaw exposes the mode and eviction controls below. DeepSeek Harness provides opt-in eviction through its native Cordis plugin. See [Host Compatibility](/hosts/compatibility) for the other adapters, including Codex's separate opt-in response-chain rebase.

## OpenClaw Mode Thresholds

| Mode | Eviction | Threshold |
| :-- | :-- | :-- |
| Conservative | Off | N/A |
| Normal | Off | N/A |
| Aggressive | On | Lower (evicts sooner) |

## OpenClaw Eviction Controls

```bash
# Toggle eviction
lightrsi eviction on
lightrsi eviction off

# In OpenClaw
/lightrsi eviction on
```

## DeepSeek Harness Eviction

Configure and enable `tokenpilot-dsh` with a durable `stateDir` and estimator and eviction settings. By default, its eviction pass runs before Harness native compaction. Optimization failures are bypassed so the agent can continue.

Inside a Harness session, inspect the result with:

```text
/tokenpilot-status
```

The command reports estimator, scheduling, application, and deferral state without creating a model turn. Follow the [DeepSeek Harness guide](/hosts/deepseek-harness) for installation and configuration; OpenClaw's `eviction` and runtime-mode commands do not apply.

## Next

- [Stable Prefix](/plugin-catalog/tokenpilot/stable-prefix) — cache optimization
- [Context Reduction](/plugin-catalog/tokenpilot/context-reduction) — trimming tool output
- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — see all metrics
