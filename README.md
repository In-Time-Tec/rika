# Rika

Rika is a greenfield, Effect-native coding agent operating system inspired by Amp Code. It is planned as a Bun + Turbo monorepo with OpenCode-shaped Effect modules, Rivet actors from day one, Drizzle-backed durable threads, and a Pi-style extension system that can safely extend or modify the agent itself.

The implementation plan is tracked as stacked GitHub issues in this repository. The repository starts as a Bun/Turbo workspace with placeholder packages for the shared schema and core Effect layers.

## Product Direction

- Amp-like terminal coding agent UX: modes, durable threads, tools, subagents, skills, plugins, MCP, review, remote control, and SDK.
- Fully Effect-native internals: services, layers, typed errors, schemas, fibers, streams, and swappable test layers.
- Rivet actor runtime from the beginning: one durable actor boundary per active thread, local-first but remote-ready.
- Drizzle persistence where data must survive process restarts: append-only event log first, projections second.
- Built-in retrieval/editing tools: `fff`, hashline read/edit, semantic search, and ast-grep outline.

## Current State

This repository currently contains the monorepo scaffold, shared protocol schemas, core Effect runtime services, and the local SQLite persistence foundation. Runtime features land through the numbered issue stack.

## Verification

```bash
bun install
bun run docs:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run format:check
```

Persistence migrations live in `packages/persistence/drizzle` and are managed through:

```bash
bun run db:generate
bun run db:migrate
```
