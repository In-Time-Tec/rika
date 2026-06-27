<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Packages

## Purpose

`packages/` contains reusable Rika workspace packages. Package code owns domain contracts, Effect services, and adapters; apps and CLIs should compose these packages rather than duplicating their internals.

## Subdirectories

| Directory      | Purpose                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------- |
| `core/`        | Core Effect service examples and future runtime/domain services. See `core/AGENTS.md`.    |
| `llm/`         | Provider-neutral LLM contracts and mode routing. See `llm/AGENTS.md`.                     |
| `persistence/` | Drizzle-backed local SQLite adapter services and migrations. See `persistence/AGENTS.md`. |
| `rivet-host/`  | RivetKit actor definitions and local host assembly. See `rivet-host/AGENTS.md`.           |
| `schema/`      | Shared schema/protocol package. See `schema/AGENTS.md`.                                   |

## Current Standards

- Package entrypoints expose module namespaces with `export * as Module from "./module"` when a package has real modules.
- Each package owns its `package.json`, `tsconfig.json`, and package-local `src/` tree.
- Package tests live in `test/`, mirroring `src/` paths exactly where possible.
- Package code must be testable through Effect service/layer substitution instead of global state.
- Keep package dependencies directed from schema/contracts toward core/runtime; adapter packages should sit behind service interfaces.

## For AI Agents

- Read the package's nested `AGENTS.md` before editing package code.
- Do not add a package just to hold a single helper; create packages only when a durable boundary exists.
- Keep generated/build output out of commits.

## Testing And Verification

- From the repository root, run `bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build` after changing package code.
- Package-local scripts may be run from the package directory for a tighter loop.

## Skills Index

<!-- AGENTS-SKILLS-START -->

[Skills Index]|local: ../.agents/skills|IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. When a task matches a skill, read its SKILL.md and follow it.|relevant:{add-effect-service}

<!-- AGENTS-SKILLS-END -->

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
