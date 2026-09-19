# Plugin Catalog

LightRSI plugins provide reusable agent capabilities. Each plugin is independently installable and works across supported hosts.

## Available Plugins

| Plugin | Capability | Status | Hosts |
| :-- | :-- | :-- | :-- |
| [TokenPilot](./tokenpilot/overview) | Cache-aware context management | <span class="badge-stable">Stable</span> | OpenClaw, Codex, Claude Code, DeepSeek Harness |

[DeepSeek Harness](/hosts/deepseek-harness) provides a native Cordis integration with opt-in context eviction and session status. Capabilities vary by host; see [Host Compatibility](/hosts/compatibility).

## Plugin Statuses

| Status | Meaning |
| :-- | :-- |
| <span class="badge-stable">Stable</span> | Installed by users, API is frozen, covered by benchmarks |
| <span class="badge-experimental">Experimental</span> | Under active development, API may change, not recommended for production |
