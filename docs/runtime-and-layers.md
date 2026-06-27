# Runtime and Layer Assembly

Rika composes runtime dependencies with Effect layers. Domain code depends on service tags; process entrypoints choose live, fake, or in-memory layers.

## Layer rules

- Use `Layer.mergeAll(...)` to assemble independent services for an entrypoint or test harness.
- Use `Layer.provide(...)` when one implementation depends on another service layer.
- Keep raw clients behind adapter services; domain-facing services expose Rika interfaces, not SDK handles.
- Use scoped layers when a service owns resources that must be finalized.
- Keep runtime wrappers at process boundaries. Package internals should return `Effect` values rather than running them.

## Current core services

- `Config`: injectable process configuration. Live values come from environment/cwd at the boundary.
- `Diagnostics`: telemetry-free diagnostic sink. Live output stays local; tests use memory sinks.
- `Time`: clock abstraction with live and fixed layers.
- `IdGenerator`: random live IDs and deterministic sequence IDs for tests.
- `TestHarness`: helper for running effects with fake core services.
- `Runtime`: managed runtime helper for process entrypoints that need promise/sync/fork adapters.

Use `packages/core/src/runtime.test.ts` as the copyable baseline for layer replacement and runtime assembly tests.
