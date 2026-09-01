# Adapter Testing

From [CONTRIBUTING.md](https://github.com/zjunlp/LightRSI/blob/main/CONTRIBUTING.md) and the [Adapter Playbook](https://github.com/zjunlp/LightRSI/blob/main/docs/adapter-playbook.md):

### Type Check

```bash
pnpm typecheck
```

### Adapter Tests

```bash
# OpenClaw adapter
npm --prefix components/adapters/openclaw test

# Codex adapter
npm --prefix components/adapters/codex test

# Claude Code adapter
npm --prefix components/adapters/claude-code test

# DeepSeek Harness compatibility smoke
pnpm --filter @lightrsi/deepseek-harness-adapter compatibility:smoke -- --dsh-checkout=/absolute/path/to/deepseek-harness
```

### Doctor Self-Check

Each adapter provides a `doctor` command for runtime self-verification:

```bash
lightrsi <host> doctor
```

Or per-adapter:

```bash
npm --prefix components/adapters/openclaw run doctor:openclaw
npm --prefix components/adapters/codex run doctor:codex
npm --prefix components/adapters/claude-code run doctor:claude-code
```

Test directories exist at `adapters/<host>/tests/`.

## Related Pages

- [Adapter Architecture](./adapter-architecture.md)
- [Adding a New Host](./adding-new-host.md)
- [Adapter Playbook](https://github.com/zjunlp/LightRSI/blob/main/docs/adapter-playbook.md)
