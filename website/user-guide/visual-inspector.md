# Visual Inspector

The visual inspector is a **browser-based dashboard** that shows TokenPilot's real-time behavior — cache efficiency, context trimming, and eviction decisions.

This shared Visual interface covers OpenClaw, Codex, and Claude Code. DeepSeek Harness exposes session status through [`/tokenpilot-status`](/hosts/deepseek-harness#verify-in-a-session); the Visual commands below do not apply to its native integration.

## Opening the Inspector

```bash
lightrsi visual
```

This starts a local web server and opens your default browser.

You can also open it per-host:

```bash
lightrsi openclaw visual
lightrsi codex visual
lightrsi claude-code visual
```

Or inside OpenClaw:

```text
/lightrsi visual
```

## Views

### Stabilizer View

Shows how the stable prefix is performing:

- **Stable vs. dynamic ratio**: What portion of the context is cache-stable vs. turn-varying
- **Cache hit rate**: Percentage of input tokens served from cache each turn
- **Per-turn stability**: A timeline showing stability metrics turn by turn

A high stable ratio and high cache hit rate mean the stabilizer is working well.

### Reduction View

Shows what TokenPilot trimmed from tool output:

- **Per-turn reduction stats**: How many bytes/tokens were trimmed each turn
- **Before/after comparison**: Tool output size before and after reduction
- **Active passes**: Which reduction passes are enabled and what they're doing

Use this view when you want to check if reduction is being too aggressive or too conservative.

### Eviction View

Shows lifecycle-aware pruning:

- **Session depth**: Current turn count and total token count
- **Eviction threshold**: The configured limit before eviction starts
- **Evicted turns**: How many turns have been pruned
- **Timeline**: When eviction happened and what was removed

Use this view when debugging why certain context seems to be missing.

## Navigating

- **Tabs** at the top switch between Stabilizer, Reduction, and Eviction views
- **Host dropdown** changes which host's data you're viewing
- **Session selector** lets you view specific sessions
- Data **auto-updates** as new turns complete

## When to Use the Inspector

| Situation | View to check |
| :-- | :-- |
| Cache savings seem lower than expected | Stabilizer |
| Model seems to miss important tool output | Reduction |
| Older context is disappearing too soon | Eviction |
| General health check | All three |

## Troubleshooting

If the inspector doesn't open:

1. Make sure TokenPilot has run at least one session
2. Check that the local server port isn't blocked
3. Try a different browser
4. Run `lightrsi doctor` to verify TokenPilot is healthy

## Next

- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — understanding the metrics
- [Logs and Diagnostics](/user-guide/logs-and-diagnostics) — text-based diagnostics
