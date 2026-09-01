# Local Development

How to set up LightRSI for local development.

## Prerequisites

Same as [installation prerequisites](/getting-started/install-lightrsi#prerequisites):
- Node.js ≥ 18 (v20+ recommended)
- pnpm ≥ 9
- Git

## Setup

```bash
git clone https://github.com/zjunlp/LightRSI.git
cd LightRSI
corepack enable
pnpm install
pnpm build
```

## Development Workflow

```bash
# Build all packages
pnpm build

# Typecheck
pnpm typecheck

# Build the CLI
pnpm lightrsi:build

# Install the CLI locally
pnpm lightrsi:install

# Run tests
pnpm lightrsi:test
```

## Per-Package Commands

```bash
# Build a specific adapter
npm --prefix components/adapters/openclaw run build

# Typecheck a specific package
npm --prefix components/packages/foundation/runtime-core run typecheck
```

## Documentation Site

```bash
# Start dev server
pnpm --dir website docs:dev

# Build for production
pnpm --dir website docs:build

# Preview production build
pnpm --dir website docs:preview
```

## Next

- [Build and Test](/development/build-and-test)
- [Repository Structure](/development/repository-structure)
- [Contributing](/development/contributing)
