---
name: add-effect-service
description: Use when adding or changing a Rika Effect service, layer, service-boundary error, or test fake in packages/core or future Effect-owned packages.
---

# Add Effect Service

Use when adding or changing a Rika Effect service, layer, service-boundary error, or test fake.

Read `AGENTS.md`, `packages/AGENTS.md`, the package-local `AGENTS.md`, and `docs/effect-module-conventions.md` before acting.

## Process

1. Create or update one service module with `Interface`, `Service`, typed errors when needed, and explicit live layer exports.
2. Export the module namespace from the package entrypoint with `export * as Module from "./module"`.
3. Keep raw adapters behind service interfaces and layers; do not expose Drizzle, Rivet, provider SDKs, or filesystem mutation from domain-facing interfaces.
4. Add or update tests that provide a fake or in-memory layer through the same `Service` tag.
5. Update local `AGENTS.md` only when the service establishes a durable package convention.

## Verification

- `bun run lint`: repository lint.
- `bun run typecheck`: package type checks through Turbo.
- `bun run test`: package tests through Turbo.
- `bun run format:check`: formatting check.

## Completion Criteria

Done only when the service can be consumed through its interface, a fake layer can replace the live layer in tests, package exports follow the namespace pattern, and verification passes.
