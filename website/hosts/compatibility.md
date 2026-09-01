# Host Compatibility

LightRSI provides three full TokenPilot host surfaces and a separate DeepSeek Harness compatibility adapter. Each integration has a different boundary, so the shared runtime behavior and host-specific capabilities are documented separately.

## Supported Hosts

| Host | Integration | Adapter Location |
| :-- | :-- | :-- |
| [OpenClaw](./openclaw) | Native plugin slot | `components/adapters/openclaw/` |
| [Codex CLI](./codex) | Local proxy + hooks | `components/adapters/codex/` |
| [Claude Code](./claude-code) | Local gateway + MCP | `components/adapters/claude-code/` |
| DeepSeek Harness | Cordis plugin + durable projection | `components/adapters/deepseek-harness/` |

DeepSeek Harness currently exposes the adapter projection and compatibility smoke path. Its canonical-surface eviction remains opt-in and is not included in the feature matrix below, which describes the TokenPilot interactive host surfaces.

## TokenPilot Host Feature Matrix

| Feature | OpenClaw | Codex | Claude Code |
| :-- | :-- | :-- | :-- |
| Stable Prefix | ✅ | ✅ | ✅ |
| Context Reduction | ✅ | ✅ | ✅ |
| Context Eviction | ✅ | — | — |
| Visual Inspector | ✅ | ✅ | ✅ |
| Session Reports | ✅ | ✅ | ✅ |
| In-session Commands | ✅ (`/lightrsi`) | — (standalone CLI) | — (standalone CLI) |
| Standalone CLI | ✅ | ✅ | ✅ |
| MCP Recovery Server | ✅ | ✅ | ✅ |
| `mode conservative` | ✅ | ✅ | ✅ |
| `mode normal` | ✅ | ✅ | ✅ |
| `mode aggressive` | ✅ | — | — |
| Auto-start Proxy | ✅ (gateway restart) | ✅ (SessionStart hook) | ✅ (SessionStart hook) |
