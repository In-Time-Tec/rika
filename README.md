# Rika

Rika is a greenfield, Effect-native coding agent operating system inspired by Amp Code. It is a Bun + Turbo monorepo with OpenCode-shaped Effect modules, Rivet actor orchestration, Drizzle-backed durable threads, and an extension system for skills, plugins, MCP, IDE integration, and remote control.

The implementation is growing through stacked GitHub issues, with reusable packages for the agent loop, shared schemas, persistence, tools, LLM routing, plugins, the TUI, CLI, SDK, server, IDE bridge, and Rivet host.

## Product Direction

- Amp-like terminal coding agent UX: modes, durable threads, tools, subagents, skills, plugins, MCP, review, remote control, and SDK.
- Fully Effect-native internals: services, layers, typed errors, schemas, fibers, streams, and swappable test layers.
- Rivet actor runtime from the beginning: one durable actor boundary per active thread, local-first but remote-ready.
- Drizzle persistence where data must survive process restarts: append-only event log first, projections second.
- Built-in retrieval/editing tools: `fff`, hashline read/edit, semantic search, and ast-grep outline.

## Current State

This repository currently contains the monorepo scaffold, shared protocol schemas, core Effect runtime services, local SQLite persistence foundation, default built-in tools, agent context resolution, thread lifecycle/search/share services, an initial Amp-like interactive terminal adapter, the trusted-local TypeScript plugin host, MCP client integration with workspace command-server trust controls, IDE/SDK remote control, and local/remote Rivet host configuration with workspace membership checks. Runtime features continue to land through the numbered issue stack.

## Verification

Install and run locally from source:

```bash
bun install
bun run package:smoke
bun run install:local
rika doctor
```

Update a local install with:

```bash
git pull --ff-only
bun install
bun run update:local
```

The full owner manual lives in `docs/OWNER_MANUAL.md`; security guidance lives in `docs/SECURITY.md`; launch gates live in `docs/LAUNCH_CHECKLIST.md`.

## Development Verification

```bash
bun install
bun run docs:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run format:check
bun run package:smoke
```

Persistence migrations live in `packages/persistence/drizzle` and are managed through:

```bash
bun run db:generate
bun run db:migrate
```
