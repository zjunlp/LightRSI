# Adding a New Host

This page consolidates the checklists from the [Adapter Playbook](https://github.com/zjunlp/LightRSI/blob/main/docs/adapter-playbook.md) and the [Adapters README](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/README.md).

## Design First

From the [Adapter Playbook](https://github.com/zjunlp/LightRSI/blob/main/docs/adapter-playbook.md):

- Can the host rewrite requests before model execution?
- Can the host rewrite responses after model execution?
- Does the host expose streaming chunks, final responses, or both?
- Does the host expose transcript history directly, or must it be reconstructed?
- Is integration file-based, hook-based, plugin-based, or API-based?

## Required Surfaces

From the [adapters/README.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/README.md) checklist:

1. **Install surface** — where the host extension or plugin lives, how config is written, how to enable/disable/remove.
2. **Session bridge** — how session IDs, turn IDs, and workspace roots are resolved.
3. **Transcript bridge** — how raw host messages are decoded into shared envelopes and rewritten envelopes encoded back.
4. **Request / response lifecycle** — before-call rewriting, after-call reduction, tool-result persistence, streaming/non-streaming handling.
5. **State roots** — state dir, archive dir, debug trace dir.
6. **Product surface** — `status`, `report`, `doctor`, `visual`, mode switching.
7. **Verification** — adapter unit tests, one smoke install path, one end-to-end session check.

## Recommended Development Order

From the [adapters/README.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/README.md):

1. Start with the shared host envelope bridge in `components/packages/foundation/host-adapter/`.
2. Wire one minimal request path through the host.
3. Make `status` and `doctor` work first.
4. Add reduction and persistence hooks.
5. Add visual and richer command surfaces last.

## Reference Implementations

- [OpenClaw Adapter](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/openclaw/README.md)
- [Codex Adapter](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/codex/README.md)
- [Claude Code Adapter](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/claude-code/README.md)
- [DeepSeek Harness Adapter](https://github.com/zjunlp/LightRSI/tree/main/components/adapters/deepseek-harness)

## Related Pages

- [Adapter Architecture](./adapter-architecture.md)
- [Adapter Testing](./adapter-testing.md)
- [Configuration Integration](./configuration-integration.md)
- [Hook and Proxy Integration](./hook-proxy-integration.md)
- [Adapter Playbook](https://github.com/zjunlp/LightRSI/blob/main/docs/adapter-playbook.md)
- [HOSTS.md](https://github.com/zjunlp/LightRSI/blob/main/components/adapters/HOSTS.md)
