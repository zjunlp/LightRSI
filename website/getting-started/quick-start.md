# Quick Start

A minimal path from clone to a verified running session. You will have LightRSI installed with TokenPilot active in under 5 minutes.

## 1. Clone and Build

```bash
git clone https://github.com/zjunlp/LightRSI.git
cd LightRSI
corepack enable
pnpm install
pnpm build
pnpm lightrsi:build
pnpm lightrsi:install
```

The last command installs the `lightrsi` CLI entrypoint at `~/.local/bin/lightrsi`. Make sure `~/.local/bin` is on your `PATH`.

## 2. Pick Your Host

Choose your agent host and run the matching install command:

::: code-group
```bash [OpenClaw]
pnpm component:install:tokenpilot:openclaw
```

```bash [Codex]
npm --prefix components/adapters/codex run build
npm --prefix components/adapters/codex run install:codex
```

```bash [Claude Code]
npm --prefix components/adapters/claude-code run build
npm --prefix components/adapters/claude-code run install:claude-code
```
:::

Each install command:
- Updates the host's configuration files
- Enables the TokenPilot plugin
- Sets the default `normal` runtime mode
- Registers required hooks or MCP servers
- Creates backups of modified files as `.tokenpilot.bak`

## 3. Start a Session

Open or restart your host, then start a new session.

::: code-group
```text [OpenClaw]
Use a lightrsi/<model> model like lightrsi/gpt-5.4-mini
Run: /lightrsi status
```

```text [Codex]
Start Codex normally, approve TokenPilot hooks if prompted
Open a new session so SessionStart can start the proxy
```

```text [Claude Code]
Start Claude Code normally
Open a new session so SessionStart can start the gateway
```
:::

## 4. Verify It Works

Run the doctor command to confirm everything is healthy:

::: code-group
```bash [OpenClaw]
/lightrsi doctor
# Or outside OpenClaw:
lightrsi openclaw doctor
```

```bash [Codex]
lightrsi codex doctor
```

```bash [Claude Code]
lightrsi claude-code doctor
```
:::

Expected output:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `stabilizer enabled`
- `reduction enabled`
- `proxy healthy: yes`

## 5. See Your Savings

After a few turns, check your report:

::: code-group
```bash [OpenClaw]
/lightrsi report
```

```bash [Codex]
lightrsi codex report
```

```bash [Claude Code]
lightrsi claude-code report
```
:::

If you see token and cost metrics instead of "No TokenPilot session stats yet", TokenPilot is actively managing your context.

## 6. Visual Inspector

Open the built-in visual inspector to see your session in real time:

```bash
lightrsi visual
```

This opens a browser view showing stable-prefix, reduction, and eviction snapshots.

## What's Next

- [Install Your First Plugin](/getting-started/install-first-plugin) — detailed install walkthrough
- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — choose conservative, normal, or aggressive
- [CLI Reference](/user-guide/cli-reference) — all commands and flags
