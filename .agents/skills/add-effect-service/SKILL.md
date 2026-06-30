---
name: add-effect-service
description: Use when adding or changing a Rika Effect service, layer, service-boundary error, runtime composition, or test fake in any Effect-owned package.
---

# Add Effect Service

Use when adding or changing a Rika Effect service, layer, service-boundary error, or test fake.

Read `AGENTS.md`, `packages/AGENTS.md`, the package-local `AGENTS.md`, and `docs/effect-module-conventions.md` before acting.

## Process

1. Create or update one service module with `Interface`, `Service`, typed errors when needed, and explicit live layer exports.
2. Export the module namespace from the package entrypoint with `export * as Module from "./module"`.
3. Keep raw adapters behind service interfaces and layers; do not expose Drizzle, Rivet, provider SDKs, OpenTUI, process I/O, or filesystem mutation from domain-facing interfaces.
4. Compose runtime layers at process boundaries only. Package internals should return `Effect`, `Stream`, or layer values rather than constructing runtimes or keeping singleton state.
5. Add or update tests that provide a fake, memory, or deterministic layer through the same `Service` tag.
6. Update local `AGENTS.md` only when the service establishes a durable package convention, runtime composition rule, or adapter boundary.

## Verification

- `bun run lint`: repository lint.
- `bun run typecheck`: package type checks through Turbo.
- `bun run test`: package tests through Turbo.
- `bun run format:check`: formatting check.

## Completion Criteria

Done only when the service can be consumed through its interface, a fake or memory layer can replace the live layer in tests, package exports follow the namespace pattern, runtime composition stays at the intended boundary, and verification passes.
