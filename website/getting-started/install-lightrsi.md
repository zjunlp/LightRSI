# Install LightRSI

This page covers the LightRSI platform installation — the shared runtime that all plugins need. After this, install your first plugin (e.g., TokenPilot).

## Prerequisites

| Requirement | Minimum | Notes |
| :-- | :-- | :-- |
| **Node.js** | ≥ 18 | v20+ recommended |
| **pnpm** | ≥ 9 | v10.32+ used in development |
| **OS** | macOS, Linux, Windows (WSL) | Windows native may work but is less tested |
| **Target Host** | OpenClaw / Codex / Claude Code for full TokenPilot support; DeepSeek Harness for compatibility smoke testing | At least one target integration must be available |

No cloud services, API keys, or external dependencies are required.

## Step 1: Clone the Repository

```bash
git clone https://github.com/zjunlp/LightRSI.git
cd LightRSI
```

## Step 2: Enable Corepack and Install

```bash
corepack enable
pnpm install
```

This installs all workspace dependencies across the plugin packages and host adapters.

## Step 3: Build Shared Packages

```bash
pnpm build
```

This builds the shared foundation and feature packages that plugins and adapters depend on.

## Step 4: Build and Install the CLI

```bash
pnpm lightrsi:build
pnpm lightrsi:install
```

The first command builds the shared `lightrsi` CLI. The second installs it to
`~/.local/bin/lightrsi` on Linux/macOS. For the complete Codex or Claude Code
Cleaner flow, use `pnpm cleaner:install:codex` or
`pnpm cleaner:install:claude-code`; those commands also build the recovery MCP,
selected adapter, and `lightrsi-clean` command skill. On Windows they create a
`lightrsi.cmd` launcher.

::: warning PATH notice Make sure `~/.local/bin` is on your `PATH`. Add this to your shell config if needed:

```bash
export PATH="$HOME/.local/bin:$PATH"
```
:::

## Verify Installation

```bash
lightrsi --help
```

You should see the top-level command listing.

```bash
lightrsi context
```

This shows your current default host, pinned session, and config target.

## What Got Installed

| Component | Location | Purpose |
| :-- | :-- | :-- |
| `lightrsi` CLI | `~/.local/bin/lightrsi` | Standalone CLI for all hosts |
| Shared packages | `node_modules/` (workspace) | Runtime engine, types, contracts |
| Host adapter code | `components/adapters/` | Per-host integration code |

## Next

- [Install Your First Plugin](/getting-started/install-first-plugin) — install TokenPilot for your host
- [Quick Start](/getting-started/quick-start) — end-to-end walkthrough
