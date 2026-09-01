# LightRSI CLI Product

This package builds the shared `lightrsi` command and browser Visual launcher. It is a product surface, not a host adapter and not an owner of TokenPilot algorithms.

Host identity, state discovery, and preset ownership come from adapter-provided `ProductHostRegistration` records. The CLI adds host command runtime factories for the full TokenPilot surfaces (OpenClaw, Codex, and Claude Code), then uses one registry for:

- host parsing and usage text
- command runtime selection
- latest-report host selection
- multi-host Visual discovery

The CLI explicitly initializes the TokenPilot preset so cache-audit and other feature product contributions are available even when no host proxy is started inside the CLI process.

```bash
pnpm --dir components/products/cli build
pnpm --dir components/products/cli typecheck
pnpm --dir components/products/cli test
```
