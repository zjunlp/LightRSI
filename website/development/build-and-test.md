# Build and Test

Commands for building, typechecking, and testing LightRSI.

## Build

```bash
# Build everything
pnpm build

# Build the CLI specifically
pnpm lightrsi:build
pnpm lightrsi:install

# Build specific adapter
npm --prefix components/adapters/openclaw run build
npm --prefix components/adapters/codex run build
npm --prefix components/adapters/claude-code run build
```

## Typecheck

```bash
# Typecheck all packages
pnpm typecheck

# Typecheck specific package
npm --prefix components/packages/foundation/runtime-core run typecheck
```

## Test

```bash
# Run all tests
pnpm lightrsi:test

# Run tests for specific package
npm --prefix components/products/cli test
```

## CI

GitHub Actions workflows are in `.github/workflows/`. The CI runs:
- Typecheck
- Build
- Tests

## Documentation

```bash
pnpm --dir website docs:dev      # Dev server with hot reload
pnpm --dir website docs:build    # Production build
pnpm --dir website docs:preview  # Preview production build
```

## Next

- [Local Development](/development/local-development)
- [Contributing](/development/contributing)
