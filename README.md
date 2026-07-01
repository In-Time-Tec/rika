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

This repository currently contains the monorepo scaffold, shared protocol schemas, core Effect runtime services, local SQLite persistence foundation, default built-in tools, agent context resolution, thread lifecycle/search/share services, an initial Amp-like interactive terminal adapter, the trusted-local TypeScript plugin host, MCP client integration with workspace command-server trust controls, IDE/SDK remote control, shared local backend live subscriptions, a Foldkit local web UI, and local/remote Rivet host configuration with workspace membership checks. Runtime features continue to land through the numbered issue stack.

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

Run the local Foldkit web UI against the shared backend with:

```bash
bun run web:dev
```

Persistence migrations live in `packages/persistence/drizzle` and are managed through:

```bash
bun run db:generate
bun run db:migrate
```

## Random Notes

- Rika should feel fast, durable, and boring in the best way.
- Tools are most useful when they leave a clear trail for the next agent.
- If something can be rebuilt from the event log, prefer rebuilding it over making it canonical.
- Keep the terminal loop calm: fast feedback, readable state, and no surprise ceremony.
- Prefer small reversible changes over heroic rewrites.
- Good defaults should make the common path feel obvious without hiding the escape hatch.
- A future agent should be able to understand what happened from the durable trail, not from folklore.
- The best debugging session ends with one fewer mystery and one better name.
- Prefer boring persistence, sharp interfaces, and cheerful local development.
- When in doubt, make the next useful action obvious.
- Rika should be easy to restart, easy to inspect, and hard to confuse.
- Cache the obvious, log the important, and keep the weird parts searchable.
- A calm agent explains its next move before it makes the repo louder.
- Local development should feel like opening a notebook, not launching a spaceship.
- Durable threads are only useful if humans can skim them later.
- Every escape hatch should have a label, a trail, and a way back.
- Tiny paper cuts deserve names before they become architecture.
- Prefer a visible queue over a mysterious spinner.
- The happiest path should still leave breadcrumbs for the sad path.
- Make retries patient, cancellation cheap, and recovery unsurprising.
- A good local tool should work before the coffee cools.
- Keep logs crisp enough for machines and friendly enough for tired humans.
- Prefer one trustworthy source of truth over three clever caches.
- A tiny green check should mean something real happened.
- Make the local path delightful before making the remote path dramatic.
- The agent should carry a flashlight, not a fog machine.
- Random note: invisible llamas prefer deterministic build logs.
- Add a tiny umbrella for every cache miss.
- The moon can be a feature flag if the rollback path is obvious.
- Sprinkle confetti only after the tests have stopped blinking.
- A rubber duck with a trace ID is still observability.
- Keep a spare metaphor in the toolbox for confusing migrations.
- The best yak shave has a receipt, a broom, and an exit sign.
- If the terminal starts humming, check the queue before blaming the moon.
- Name the gremlin, write the test, then let the gremlin retire.
- A well-labeled button is cheaper than a support séance.
- Every tiny dragon deserves a tiny runbook.
