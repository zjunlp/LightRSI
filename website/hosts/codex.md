# Codex CLI

Codex CLI integration uses a **local proxy + hooks** pattern. TokenPilot runs as a sidecar proxy that intercepts requests between Codex and the model API.

## Installation

```bash
npm --prefix components/adapters/codex run build
npm --prefix components/adapters/codex run install:codex
```

This command:
- Keeps your current active Codex provider name
- Reroutes that provider through the local TokenPilot proxy
- Writes `~/.codex/tokenpilot.json`
- Registers hooks in `~/.codex/hooks.json`
- Registers the shared `tokenpilot_memory_fault_recover` MCP server
- Creates the `lightrsi` CLI entrypoint at `~/.local/bin/lightrsi`

### Custom Paths

```bash
export CODEX_CONFIG_PATH="/path/to/config.toml"
export CODEX_HOOKS_CONFIG_PATH="/path/to/hooks.json"
export TOKENPILOT_CODEX_CONFIG="/path/to/tokenpilot.json"
npm --prefix components/adapters/codex run build
npm --prefix components/adapters/codex run install:codex
```

## Expected Output

After install, these files are created or modified:

| File | Purpose |
| :-- | :-- |
| `~/.codex/tokenpilot.json` | TokenPilot plugin configuration |
| `~/.codex/hooks.json` | SessionStart and other hook registrations |
| Config backups | `*.tokenpilot.bak` alongside originals |

## Verification

```bash
lightrsi codex status
lightrsi codex doctor
```

Expected output:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `stabilizer enabled`
- `reduction enabled`
- `proxy healthy: yes`

## First Run

1. Start Codex normally
2. If Codex asks you to review or trust the installed TokenPilot hooks, **approve them**
3. Open a **new session** so `SessionStart` can start the local proxy
4. In another terminal, verify:

```bash
lightrsi codex doctor
```

::: warning Proxy may not start before first trusted session Install success does not guarantee the proxy is already running. If `doctor` still reports `proxy healthy: no` after trusting hooks and opening a new Codex session, use the manual fallback:
```bash
tokenpilot-codex status
tokenpilot-codex start
```
:::

## Standalone CLI

All commands use the standalone CLI:

```bash
lightrsi codex status
lightrsi codex report
lightrsi codex doctor
lightrsi codex visual
lightrsi codex session <session-id> report
lightrsi codex reduction status
lightrsi codex stabilizer target developer
lightrsi codex mode normal
lightrsi codex reduction mode balanced
lightrsi codex help
```

## PATH Setup

If `lightrsi` is not found after install:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Add to `~/.bashrc` or `~/.zshrc` to make permanent.

## Troubleshooting

See [TokenPilot Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting#codex) for Codex-specific issues.
