# Rika

## Purpose

Rika is a local-only personal coding-agent CLI and OpenTUI application. Its committed dependency contract consumes released Baton and Relay packages and uses Effect v4 throughout.

## Keep the project greenfield

Rika has no users and no compatibility obligation. Do not preserve old code, formats, names, commands, or behavior unless the current specification still requires them. Remove superseded paths instead of adding aliases, fallback decoders, migrations, deprecation layers, or dual behavior. If a change replaces a contract, update every caller, test, fixture, and document in the same change.

## Effect is non-negotiable

- **All code in this repository MUST be Effect-native and Effect-idiomatic. This is the primary engineering constraint, not a preference.** It applies to production code, tests, scripts, CLIs, adapters, and examples—not only services. A change that works but is not idiomatic Effect is not complete.
- **Effect research is a required stop gate before coding.** Before designing or implementing a capability, search the pinned `effect` source, types, tests, and package exports in `node_modules` for an existing module, service, data type, combinator, platform integration, or test utility. Do not rely on memory, generic TypeScript habits, or stale examples. If Effect ships the capability, use it.
- **Do not write typical Promise-based TypeScript.** No `async`/`await`, raw `Promise` construction, Promise-returning internal APIs, `Promise.all`/`race`/`allSettled`, or chains of `.then()`/`.catch()` as the program model. Do not use a Promise implementation as an intermediate step and wrap it in `Effect` afterward.
- Model programs as typed values. Use `Effect` for sequencing and failures; `Context` and `Layer` for dependencies; `Schema` for validation; `Stream`/`Sink`/`Channel` for streaming; `Scope` and `Effect.acquireRelease` for lifecycles; `Schedule` for retry and repetition; `Fiber`, `Queue`, `PubSub`, `Deferred`, `Ref`, and other Effect concurrency primitives for coordination.
- Use typed errors in the `Effect` error channel. Do not throw for expected failures, erase errors to `unknown`, or catch broadly and convert failures to generic exceptions. Keep requirements and failure types visible in public and internal signatures.
- Use Effect platform services instead of raw globals and runtime APIs whenever an Effect API exists. This includes time, sleep, randomness, environment/config, logging, tracing, metrics, filesystem, paths, terminal, processes, HTTP, sockets, signals, and cancellation. Calls such as `Date.now`, `setTimeout`, `Math.random`, direct `process.env`, raw `fetch`, and direct filesystem APIs are forbidden when Effect provides the concern.
- A Promise, callback, or raw platform API is allowed only at the outermost integration boundary when no Effect-native module exists. Prove that absence by searching Effect first. Keep the interop in one adapter, convert it immediately with the appropriate Effect constructor, map defects and rejection values into typed errors, preserve cancellation and resource safety, and expose only an Effect-native interface.
- Do not recreate Effect APIs with local helpers, weaken Effect types for convenience, hide non-Effect code behind an Effect-shaped wrapper, or build parallel abstractions for capabilities Effect already owns. Using Effect only at the final call site is not Effect-native.
- When touching existing Promise-based or raw-platform code, do not copy or extend that pattern. Migrate the affected path to Effect as part of the change unless it is a documented unavoidable outer boundary.
- Treat Effect violations as review blockers. Before reporting completion, inspect the changed code for `async`, `await`, `Promise`, `.then`, `.catch`, raw timers, thrown expected errors, and direct platform APIs; justify every unavoidable boundary in the final report.
- Research upstream behavior in this order: inspect current `main` in `repos/baton`, `repos/relay`, and `repos/effect` as relevant for capabilities and patterns, then inspect the installed pinned package source, types, tests, and exports in `node_modules` for compile-time API truth. Newer upstream source does not prove an installed API exists; upgrade the package version before using a newer source API.
- Rika directly owns three read-only, branch-tracking research submodules: `repos/effect` is `https://github.com/Effect-TS/effect-smol.git` on `main`, `repos/baton` is `https://github.com/In-Time-Tec/batonfx.git` on `main`, and `repos/relay` is `https://github.com/In-Time-Tec/relayfx.git` on `main`. Never import from or edit, format, lint, build, or test these vendored trees. Do not initialize nested Relay or Baton vendors.
- Run `bun run vendor:setup` after cloning. It installs the managed Git hooks and initializes direct vendors. Merge, fast-forward, and rebase pulls discover and update every direct submodule declared in `.gitmodules`, so future submodules require no hook changes. If a hook was bypassed or fails, run `bun run vendor:update` and resolve the reported error.
- Keep pure computations pure; Effect-native does not mean wrapping deterministic data transformations in `Effect.sync`. Introduce `Effect` where there is failure, a requirement, asynchrony, resource ownership, observability, or another real effect.
- Effects must remain lazy and composable. Do not execute Effects during module initialization or inside library code. Calls to `Effect.runSync`, `Effect.runPromise`, `Effect.runFork`, and related runners belong only at explicit application, process, test-host, or external-framework boundaries.
- Preserve structured concurrency and resource safety. Do not create detached work, unscoped resources, unbounded concurrency, or unbounded queues. Every forked fiber has an owner, every acquired resource has a scoped release, and concurrency and buffering limits come from an explicit policy.
- Retries and repetition must use `Schedule`, be finite or otherwise deliberately bounded, and be safe for the operation being repeated. Do not retry non-idempotent side effects without an explicit idempotency design.
- Tests must use Effect's test integrations and deterministic services when the behavior is Effectful. Prefer `@effect/vitest`, test layers, `TestClock`, and Effect coordination primitives over running Effects through Promises, real sleeps, or timing guesses.
- Do not silence Effect diagnostics with casts, `any`, `unknown` error channels, broad catch handlers, diagnostic suppression comments, or premature `Effect.run*` calls. Fix the model so success, failure, requirements, lifetime, and concurrency remain visible in the types.
- Completion reports for Effect changes must name the Effect source modules or local examples consulted and confirm that errors, requirements, runtime boundaries, resource lifetimes, and concurrency were reviewed—not merely that tests passed.

## Required Reading

- `CONTEXT.md` for vocabulary.
- `SPEC.md` for feature and decision ownership.
- `PLAN.md` for implementation sequence and gates.
- `TODO.md` for current execution status.
- `docs/features/FEATURES.md` for product coverage.

## Architecture Rules

- Rika commits published Baton and Relay package versions. The explicit `bun run upstream:link` development overlay may link sibling public packages without changing the manifest or lockfile; never copy, vendor, fork, deep-import, or commit local links.
- Relay owns durable execution, child runs, waits, joins, and replay.
- Baton owns the agent loop and model/tool protocol.
- Use Effect APIs for concurrency, scope, streams, config, CLI, platform I/O, SQL, HTTP, WebSockets, schedules, retries, and errors when available.
- Build every CLI surface with `effect/unstable/cli`.
- Use Effect SQL for Rika-owned SQLite state.
- Use WebSockets, never SSE, for any Rika-owned live execution/control process transport. Provider and MCP transports follow their package contracts.
- Keep OpenTUI imports inside the TUI adapter.
- Do not implement semantic search or ast-grep outline tools.
- Do not introduce Rivet, actors, web, IDE, remote runners, or orbs.
- Do not use direct provider SDKs.
- Do not put comments in code.
- Do not create `utils`, `helpers`, `common`, or `lib` catch-all modules.

## Effect Module Rules

- Package entrypoints export intentional namespaces.
- Services export an `Interface`, `Context.Service`, explicit layers, tagged boundary errors, and a test or memory layer.
- Service methods and workflows use `Effect.fn("Module.method")`.
- Bind yielded services to named variables before invoking methods.
- Run Effects only at app, test, or SDK host boundaries.
- Read environment values at one app configuration boundary.

## Documentation Discipline

- Update the feature ledger when feature status changes.
- Update the owning spec before changing a public contract or behavior.
- Add or amend an ADR before changing a stable architectural decision.
- Update `TODO.md` in the same change as completed work.
- Record verification evidence rather than claiming parity from code presence.

## Verification

Effect-based unit and service tests use `@effect/vitest` `it.effect` or `it.scoped`. Use `bun:test` only for Bun-native SQLite, OpenTUI, packaged-process, or other runtime integration that cannot load under Vitest.

Pilotty and agent-tty are the required interactive TUI acceptance harnesses. Load the project skills `testing-with-pilotty` and `testing-with-agent-tty` before using them. Use Pilotty for fast PTY interaction and semantic comparisons. Use agent-tty for Ghostty-backed snapshots, PNG screenshots, recordings, and final reviewer-facing evidence. Test the packaged Rika binary and installed Amp at identical terminal dimensions. Exercise every affected keyboard, mouse, resize, streaming, tool, permission, queue, thread, replay, and exit flow. Use isolated state and `RIKA_TEST_MODEL_SCRIPT` for deterministic agentic workflows. Do not claim visual parity from reducer tests or synthetic frames alone.

```bash
bun run docs:check
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run package:smoke
```
