# TokenPilot Installation

TokenPilot is installed as part of [installing your first plugin](/getting-started/install-first-plugin). This page covers TokenPilot-specific details.

Choose your host below. DeepSeek Harness uses the Harness profile plugin installer; OpenClaw, Codex, and Claude Code use their host adapter installers.

## Prerequisites

Before installing TokenPilot, complete [Install LightRSI](/getting-started/install-lightrsi).

## Install Commands

::: code-group
```bash [OpenClaw]
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

## What the Installer Does

For OpenClaw, Codex, and Claude Code, the host installation flow:

1. **Builds the adapter** for your host
2. **Updates host configuration** files with TokenPilot settings
3. **Enables the plugin** (sets `enabled: true`)
4. **Sets default mode** to `normal`
5. **Registers hooks/MCP/proxy** needed for runtime operation
6. **Creates backups** of modified files as `.tokenpilot.bak`

For DeepSeek Harness, the package registers `tokenpilot-dsh` in the selected profile. Replace the archive path with your generated `.tgz`. The integration is disabled by default and requires a persistent `stateDir` plus estimator and eviction configuration before enabling it. Follow [Configure and Enable](/hosts/deepseek-harness#configure-and-enable); shared runtime modes and proxy installation do not apply.

## Verify Installation

Run the verification command for your host:

::: code-group
```bash [OpenClaw]
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

For the first three hosts, check:
- `plugin entry enabled`
- `config enabled`
- `mode normal`
- `stabilizer enabled`
- `reduction enabled`

For Codex and Claude Code, also check:
- `proxy healthy: yes`

In DeepSeek Harness, run `/tokenpilot-status` inside a session. It reports estimator, scheduling, application, and deferral state without creating a model turn. See [verification details](/hosts/deepseek-harness#verify-in-a-session).

## Install with Custom Paths

If your host files are not in the default locations, set environment variables before running the install command. See [Install Your First Plugin](/getting-started/install-first-plugin) for the full list.

## Failed Install?

Check [Troubleshooting](/plugin-catalog/tokenpilot/troubleshooting) for common install problems, or [DeepSeek Harness troubleshooting](/hosts/deepseek-harness#troubleshooting) for profile and estimator setup. The backup restoration examples below apply to OpenClaw and Claude Code, not Harness profiles.

### Quick recovery

```bash
# Restore from backups
cp ~/.openclaw/openclaw.json.tokenpilot.bak ~/.openclaw/openclaw.json
cp ~/.claude/settings.json.tokenpilot.bak ~/.claude/settings.json
# etc.
```

## Next

- [Configuration](/plugin-catalog/tokenpilot/configuration) — tune TokenPilot settings
- [Quick Start](/getting-started/quick-start) — start using TokenPilot
