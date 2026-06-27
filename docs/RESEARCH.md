# Rika Research Notes

These notes preserve the initial product and architecture research that shaped the issue stack. They are not a full specification; the GitHub issues are the shipping plan.

## Amp Surface To Match

Rika should eventually cover the core Amp product surface:

- Agent modes comparable to deep, smart, and rush.
- Durable, searchable, shareable, archivable threads.
- Thread references, file mentions, image attachments, and AGENTS.md guidance.
- Built-in tools plus subagents, skills, Oracle/Librarian/Painter-like specialty tools, and code review checks.
- MCP servers with trust/approval boundaries.
- TypeScript plugins that register events, tools, commands, UI, permissions, custom modes, and custom subagents.
- Interactive CLI/TUI, non-interactive execute mode, streaming JSON, SDK, remote control, and IDE integration seams.

## Local Reference Repos

### OpenCode

Use OpenCode as the primary Effect module-shape reference:

- Barrel exports use `export * as Module from "./module"`.
- Modules expose `Interface`, `Service`, and `layer`/`defaultLayer` values.
- Services use `Context.Service` and `Layer.effect`.
- Workflows use `Effect.fn(...)`, typed errors with `Schema.TaggedErrorClass`, and explicit dependency layers.
- Persistence is hidden behind Effect services, not called directly from UI/runtime code.

### Pi

Use Pi as the reference for extension-first agent customization:

- Extensions can add or replace tools and prompts.
- Agent behavior should be inspectable and modifiable by local packages.
- Self-extension must remain policy-governed: executable extension code is powerful and must be trusted, auditable, and reversible.

## Runtime Architecture

- Effect is the domain and orchestration language.
- LLM integration should compose `effect/unstable/ai` and official Effect AI provider packages, starting with `@effect/ai-openai`; Rika should not hand-roll provider HTTP/SSE adapters.
- Rivet hosts actors from day one.
- Drizzle stores durable facts and migrations.
- A thread actor owns hot runtime state for one thread, but Drizzle's append-only event log remains canonical.
- Projections can be rebuilt from events and should not become a second source of truth.

## Persistence Research

Drizzle supports Bun SQLite directly and has current Effect integration for PostgreSQL through `drizzle-orm/effect-postgres`. OpenCode also demonstrates an Effect-native SQLite bridge around Drizzle, `@effect/sql-sqlite-bun`, and `Layer`-provided database services.

Rika should start SQLite-local with a DB service that:

- Runs migrations through an Effect service.
- Applies SQLite pragmas centrally.
- Exposes repositories/event logs as Effect services.
- Keeps raw Drizzle handles inside persistence modules.
- Provides test layers backed by in-memory SQLite.

## Tool Research

### fff

`fff` is a Rust-native file search SDK with Bun and Node bindings. The Bun package is `@ff-labs/fff-bun` and exposes `FileFinder.create({ basePath, aiMode, frecencyDbPath, historyDbPath, ... })`, `waitForScan`, `fileSearch`, `glob`, `grep`, `directorySearch`, `multiGrep`, health checks, scan progress, and `destroy`.

Rika should use `fff` as the default path/content search engine instead of shelling out to `rg`/`fd` for ordinary search. The service should expose Effect tools for fuzzy file search, content grep, glob filtering, directory search, health, and rescan.

### Hashline editing

Hashline read/edit tools emit line anchors such as `LINE:HASH|content` and require mutating edits to reference fresh anchors. This detects stale context and prevents silent relocation. The readmap implementation also supports structural maps, symbol reads, anchored grep output, atomic writes, diff metadata, and syntax-regression validation.

Rika should make hashline read/edit the default editing protocol:

- `read` returns text with stable anchors and structured metadata.
- `edit` rejects stale anchors before writing.
- Multi-edit batches validate against one pre-edit snapshot and apply bottom-up.
- Search results should include anchors when possible so the agent can patch without a second read.

### semantic-search

The local `semantic-search` repo already exposes an Effect-native library plus Amp/OpenCode/Pi integrations. Rika should embed it as a default semantic/hybrid code search package rather than treating it as an external MCP-only tool.

### ast-grep-outline

The local `ast-grep-outline` repo wraps `ast-grep outline` as an agent tool. Rika should ship an equivalent built-in structural outline tool that respects `sgconfig.yml`, supports custom outline rules, and returns compact symbol/navigation output.
