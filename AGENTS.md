# Rika

Rika is a local coding-agent CLI and OpenTUI app written in Effect TypeScript. Read `PRODUCT.md` for direction and `CONTEXT.md` for vocabulary and ownership.

## Boundaries

- Relay owns durable execution; Baton owns the agent loop; Rika owns product semantics and projections.
- Use released Baton, Relay, Effect, and OpenTUI package exports. Never edit, import from, format, build, or test `repos/*`.
- Use Effect services, schemas, streams, scopes, typed errors, platform APIs, and structured concurrency. Keep raw Promise or host APIs in a named outer adapter only when Effect has no equivalent.
- Run Effects only at app, process, test-host, or framework boundaries. Keep pure computations pure.
- Build CLI surfaces with `effect/unstable/cli`, use Effect SQL for Rika SQLite state, use WebSockets for Rika process transport, and keep OpenTUI imports in the TUI adapter.
- Language-model provider SDKs are forbidden outside released Baton contracts. `@rika/tools` may use web-research provider SDKs only when they preserve Effect interruption, retry, and resource semantics; otherwise use Effect HTTP adapters.
- Do not add Rivet, actors, web or IDE clients, remote runners, orbs, a local semantic code index, or ast-grep outline tools. External semantic code research is allowed through web-research providers.
- Do not create catch-all `utils`, `helpers`, `common`, or `lib` modules. Do not put comments in code.

## Documentation

- `PRODUCT.md` owns audience, direction, and exclusions. It never lists features or status.
- `CONTEXT.md` owns vocabulary, authority, and framework boundaries.
- `docs/features/<capability>.md` owns one current capability contract. Keep it short and merge overlap into the owning capability.
- `docs/decisions/<slug>.md` records only a lasting choice and why. `docs/tradeoffs/<slug>.md` records only a meaningful gain, cost, and rejected options.
- Do not create documentation indexes, ledgers, status or evidence tables, numbered specs, decision-record metadata, plans, history sections, related-link sections, or Markdown meaning/structure validators.
- `PLAN.md`, `TODO.md`, and `ISSUES.md` may track unfinished work but never define architecture or product behavior.

## Scripts and verification

- Root everyday scripts are `build`, `check`, `dev`, `format`, `test`, and `typecheck`. Plain package, migration, release, and install workflows are allowed.
- Keep one simple supported command per workflow and each `package.json` script to one command. Let Bun, Vitest, Turborepo, and their configuration own discovery, setup, concurrency, and task order instead of custom orchestration or one-off file lists.
- Do not add colon-named aliases, dispatchers that hide old aliases, or wrappers for Git, Docker, status, logs, watch, coverage, vendor, or upstream commands.
- Use `bun run package -- --target <target>` for target packaging.
- Unit tests are the default and use `*.test.ts` for one owned behavior or interface. They may use real SQLite, filesystem, process, or OpenTUI adapters.
- Scene tests use `*.scene.test.ts` and `apps/rika/test/scene.ts` for user-visible interactive behavior with the real local stack and a scripted model.
- Journey tests use `*.journey.test.ts` under `test/journey/` and exercise the packaged product through real processes or user paths.
- Stress and live are profiles, not separate test levels. Stress Journeys use `*.stress.journey.test.ts`; runtime and adapter needs do not change a test's level.
- `bun run test` owns deterministic Unit, Scene, and Journey checks. Use `@effect/vitest` and `TestClock` for Effect behavior and time; use `bun:test` only when a Bun API or packaged process requires it.
- `bun run stress` owns packaged CLI load, endurance, and live-process timing. Do not put stress cycles or real-time waits in `bun run test`.
- Run focused tests while working, then `bun run check` when the risk and time budget permit. Report what ran and what did not.
