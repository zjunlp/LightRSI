# Sessions

A **session** is one continuous conversation with your agent host. TokenPilot tracks per-session metrics and applies context management within each session.

The CLI report and session-pinning examples below apply to OpenClaw, Codex, and Claude Code. In DeepSeek Harness, open the relevant session and run [`/tokenpilot-status`](/hosts/deepseek-harness#verify-in-a-session) to inspect estimator, scheduling, application, and deferral state.

## Viewing Session Info

```bash
# Current session summary
lightrsi report

# Specific session
lightrsi codex session <session-id> report
lightrsi claude-code session <session-id> report
```

## Pinning a Session

Pin a session to make it the default for subsequent commands:

```bash
lightrsi use codex session <session-id>
lightrsi use claude-code session <session-id>
```

Now `lightrsi report` and `lightrsi visual` will use the pinned session.

## Session Reports

The report shows metrics accumulated over the session:

- Total input tokens
- Cache read vs. cache miss
- Output tokens
- Estimated cost

## Next

- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — understanding reports
- [CLI Reference](/user-guide/cli-reference) — session commands
- [Reports and Visuals](/plugin-catalog/tokenpilot/reports-and-visuals) — browser dashboard
