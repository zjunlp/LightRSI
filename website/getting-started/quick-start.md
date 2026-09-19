# Quick Start

A path from clone to a verified running session. Choose OpenClaw, Codex, Claude Code, or DeepSeek Harness at each host-specific step below.

## 1. Prepare the Repository

```bash
git clone https://github.com/zjunlp/LightRSI.git
cd LightRSI
corepack enable
pnpm install
```

The host-specific commands below build and install the selected integration. DeepSeek Harness also requires a working Harness checkout and Node.js matching the [adapter requirements](/hosts/deepseek-harness#install).

## 2. Pick Your Host

Choose your agent host and run the matching install command:

::: code-group
```bash [OpenClaw]
pnpm lightrsi:build
pnpm lightrsi:install
pnpm component:install:tokenpilot:openclaw
```

```bash [Codex]
corepack pnpm cleaner:install:codex
```

```bash [Claude Code]
corepack pnpm cleaner:install:claude-code
```

```bash [DeepSeek Harness]
# From the LightRSI repository
corepack pnpm --filter @lightrsi/deepseek-harness-adapter build
corepack pnpm --filter @lightrsi/deepseek-harness-adapter pack --pack-destination ./artifacts

# Then, from your DeepSeek Harness checkout
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add /absolute/path/to/lightrsi-deepseek-harness-adapter-<version>.tgz
```
:::

OpenClaw, Codex, and Claude Code installers configure their host integrations. See [Install Your First Plugin](/getting-started/install-first-plugin) for the changes each installer makes.

For OpenClaw, the first two commands separately build and install the shared `lightrsi` CLI used later in this walkthrough; the OpenClaw plugin installer does not install it. The CLI installer is a Bash script, so use a Bash environment (such as WSL on Windows). Its default command directory is `~/.local/bin`; ensure it is on your `PATH`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

If you set `LIGHTRSI_BIN_DIR`, add that directory instead. Codex and Claude Code's `cleaner:install:*` commands already build and install the shared CLI.

DeepSeek Harness installs the `tokenpilot-dsh` Cordis plugin into the selected profile. Replace the archive path with the generated `.tgz` and `web` with your profile. The plugin is **disabled by default**: supply a persistent `stateDir` and estimator and eviction settings, then enable it as described in [Configure and Enable](/hosts/deepseek-harness#configure-and-enable).

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

```text [DeepSeek Harness]
Load the profile containing the configured and enabled tokenpilot-dsh plugin
Open a Harness session
Run: /tokenpilot-status
```
:::

## 4. Verify It Works

Use the verification command for your host:

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

```text [DeepSeek Harness]
/tokenpilot-status
```
:::

For OpenClaw, Codex, and Claude Code, check the relevant status fields:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `stabilizer enabled`
- `reduction enabled`
- `proxy healthy: yes`

For DeepSeek Harness, inspect estimator activity, scheduling, application, and deferrals. The command is read-only and does not create a model turn. See [status field meanings](/hosts/deepseek-harness#verify-in-a-session); an enabled plugin does not imply an eviction has already occurred.

## 5. Inspect Runtime Results

After a few turns, inspect your host's report or status:

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

```text [DeepSeek Harness]
/tokenpilot-status
```
:::

For the shared CLI reports, token and cost metrics replace "No TokenPilot session stats yet" once session statistics are available. DeepSeek Harness exposes estimator, scheduled, applied, and deferred state through its native status command; it does not use `lightrsi report`.

## 6. Visual Inspector

For OpenClaw, Codex, and Claude Code, open the built-in visual inspector:

```bash
lightrsi visual
```

This opens a browser view showing stable-prefix, reduction, and eviction snapshots.

DeepSeek Harness uses `/tokenpilot-status` for the documented session status workflow; this shared Visual command does not apply to it.

## What's Next

- [Context Cleaner](/user-guide/context-cleaner) — review and clean eligible task context with explicit approval
- [Install Your First Plugin](/getting-started/install-first-plugin) — detailed install walkthrough
- [Runtime Modes](/plugin-catalog/tokenpilot/runtime-modes) — choose conservative, normal, or aggressive
- [CLI Reference](/user-guide/cli-reference) — all commands and flags
