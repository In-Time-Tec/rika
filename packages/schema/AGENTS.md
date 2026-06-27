<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Schema Package

## Purpose

`packages/schema/` owns shared schema and protocol definitions. It must stay free of runtime infrastructure so every package can depend on it safely.

## Key Files

| File                 | Purpose                                                   |
| -------------------- | --------------------------------------------------------- |
| `src/index.ts`       | Package entrypoint for schema/protocol namespace exports. |
| `src/ids.ts`         | Branded protocol ID schemas and constructors.             |
| `src/message.ts`     | Message and content-part schemas.                         |
| `src/event.ts`       | Canonical thread event union and event reference helpers. |
| `src/tool.ts`        | Tool call/result wire schemas.                            |
| `src/artifact.ts`    | Durable artifact wire schema.                             |
| `src/error.ts`       | Serializable error envelope schema.                       |
| `test/index.test.ts` | Package export and protocol round-trip tests.             |

## Current Standards

- Keep this package infrastructure-free: no Drizzle, Rivet, model SDK, filesystem mutation, TUI, CLI, or server imports.
- Use Effect Schema for serializable contracts once issue #4 defines the protocol package.
- Prefer branded IDs and versioned payload schemas over unstructured objects.
- Tests live under `test/` and import package source through `../src/index`.

## For AI Agents

- Put durable protocol vocabulary in `../../CONTEXT.md` only when it is a domain concept, not just a TypeScript type name.
- Do not add runtime service implementations here.

## Testing And Verification

- `bun run lint` from this package or `bun run lint` from the repo root.
- `bun run typecheck` from this package or `bun run typecheck` from the repo root.
- `bun run test` from this package or `bun run test` from the repo root.

## Skills Index

<!-- AGENTS-SKILLS-START -->

[Skills Index]|local: ../../.agents/skills|IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. When a task matches a skill, read its SKILL.md and follow it.|relevant:{}

<!-- AGENTS-SKILLS-END -->

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
