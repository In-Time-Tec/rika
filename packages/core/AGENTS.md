<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-27 | Updated: 2026-06-27 -->

# Core Package

## Purpose

`packages/core/` owns core Effect service patterns and future runtime/domain services. It is the copyable baseline for Rika's `Interface` / `Service` / `layer` module shape.

## Key Files

| File                           | Purpose                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| `src/config.ts`                | Injectable process configuration service and config errors.           |
| `src/diagnostics.ts`           | Telemetry-free diagnostics service with live and memory layers.       |
| `src/example-service.ts`       | Copyable Effect service and typed error example.                      |
| `src/id-generator.ts`          | Live random and deterministic sequence ID service.                    |
| `src/index.ts`                 | Package entrypoint using namespace exports.                           |
| `src/runtime.ts`               | Runtime/layer assembly helpers for process boundaries.                |
| `src/test-harness.ts`          | Test helper for running effects with fake core services.              |
| `src/time.ts`                  | Clock service with live and fixed layers.                             |
| `test/example-service.test.ts` | Layer replacement test showing live and fake service implementations. |
| `test/runtime.test.ts`         | Runtime and base service assembly tests.                              |

## Current Standards

- Export each service module through `src/index.ts` as `export * as Module from "./module"`.
- Service modules expose `Interface`, `Service`, and a live `layer` or `defaultLayer`.
- Use `Schema.TaggedErrorClass` for service-boundary errors.
- Use `Effect.fn("Module.method")` for service methods and workflows.
- Tests live under `test/` and replace services with fake layers using the same `Service` tag.
- Runtime execution helpers stay at process/test boundaries; package internals return `Effect` values.

## For AI Agents

- Read `../../docs/effect-module-conventions.md` before adding a service.
- Read `../../docs/runtime-and-layers.md` before changing base runtime composition.
- Keep raw adapters out of core service interfaces unless the interface is intentionally an adapter boundary.
- Do not introduce module-level mutable singleton state.

## Testing And Verification

- `bun run lint` from this package or `bun run lint` from the repo root.
- `bun run typecheck` from this package or `bun run typecheck` from the repo root.
- `bun run test` from this package or `bun run test` from the repo root.

## Skills Index

<!-- AGENTS-SKILLS-START -->

[Skills Index]|local: ../../.agents/skills|IMPORTANT: Prefer retrieval-led reasoning over pre-training-led reasoning. When a task matches a skill, read its SKILL.md and follow it.|relevant:{add-effect-service}

<!-- AGENTS-SKILLS-END -->

<!-- MANUAL: Add human-maintained notes below this line. They are preserved by deep-init. -->
