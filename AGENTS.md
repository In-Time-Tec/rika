# Rika

Rika is a local coding-agent CLI and OpenTUI app written in Effect TypeScript. Read `PRODUCT.md` for direction and `CONTEXT.md` for vocabulary and ownership.

## Navigation

- Start with `rg -n "<capability-or-symbol>" apps packages` to find the likely owner.
- Open that owner and its matching tests before expanding to neighboring files.

## GREENFIELD PROJECT — BREAKING CHANGES ARE WELCOME!!!

- THIS PROJECT HAS NO USERS!!! IT IS GREENFIELD!!!
- DO NOT ASSUME THAT THE EXISTING FOUNDATION, ARCHITECTURE, OR IMPLEMENTATION IS CORRECT!!! BE SKEPTICAL, INVESTIGATE THE REAL PROBLEM, AND VERIFY THE BEST APPROACH!!!
- CHANGE THE UNDERLYING FOUNDATION OR ARCHITECTURE WHEN EVIDENCE SHOWS THAT A DIFFERENT DESIGN IS BETTER!!! LARGE REFACTORS ARE ENCOURAGED WHEN THEY PRODUCE THE RIGHT LONG-TERM SYSTEM!!!
- IMPLEMENT THE RIGHT FIX THAT WILL SCALE LONG TERM, NOT THE SMALLEST PATCH!!! DO NOT PAPER OVER A DESIGN PROBLEM WITH A LOCAL WORKAROUND!!!
- BREAKING CHANGES ARE WELCOME!!! DO NOT PRESERVE LEGACY CODE OR BACKWARD COMPATIBILITY!!! REMOVE REPLACED CODE, OBSOLETE PATHS, AND TRANSITIONAL SHIMS!!!

## Boundaries

- TenetKit owns durable execution and the agent loop; Rika owns product semantics and projections.
- Use released TenetKit, Effect, and OpenTUI package exports. Never edit, import from, format, build, or test `repos/*`.
- Use Effect services, schemas, streams, scopes, typed errors, platform APIs, and structured concurrency. Keep raw Promise or host APIs in a named outer adapter only when Effect has no equivalent.
- Run Effects only at app, process, test-host, or framework boundaries. Keep pure computations pure.
- Build CLI surfaces with `effect/unstable/cli`, use Effect SQL for Rika SQLite state, use WebSockets for Rika process transport, and keep OpenTUI imports in the TUI adapter.
- Language-model provider SDKs are forbidden outside released TenetKit contracts. `@rika/coding-tools` may use web-research provider SDKs only when they preserve Effect interruption, retry, and resource semantics; otherwise use Effect HTTP adapters.
- Do not add Rivet, actors, web or IDE clients, remote runners, orbs, a local semantic code index, or ast-grep outline tools. External semantic code research is allowed through web-research providers.
- Do not create catch-all `utils`, `helpers`, `common`, or `lib` modules. Do not put comments in code.

## Documentation

- `PRODUCT.md` owns audience, direction, and exclusions. It never lists features or status.
- `CONTEXT.md` owns vocabulary, authority, and framework boundaries.
- `docs/features/<capability>.md` owns one current capability contract. Keep it short and merge overlap into the owning capability.
- `docs/decisions/<slug>.md` records only a lasting choice and why. `docs/tradeoffs/<slug>.md` records only a meaningful gain, cost, and rejected options.
- Do not create documentation indexes, ledgers, status or evidence tables, numbered specs, decision-record metadata, plans, history sections, related-link sections, or Markdown meaning/structure validators.
- `PLAN.md`, `TODO.md`, and `ISSUES.md` may track unfinished work but never define implemented product behavior.
- The TenetKit native-runtime `PLAN.md` may record target interface changes and release acceptance for this clean-break migration.
- A test-only Vitest alias may resolve TenetKit package imports to the TenetKit worktree before `0.15.0` is published. Production source must keep package-name imports. Remove the alias after Rika pins the released packages.

## Scripts and verification

- Root everyday scripts are `build`, `check`, `dev`, `format`, `test`, and `typecheck`. Plain package, migration, release, and install workflows are allowed.
- Keep one simple supported command per workflow and each `package.json` script to one command. Let Bun, Vitest, Turborepo, and their configuration own discovery, setup, concurrency, and task order instead of custom orchestration or one-off file lists.
- Do not add colon-named aliases, dispatchers that hide old aliases, or wrappers for Git, Docker, status, logs, watch, coverage, vendor, or upstream commands.
- Use `bun run package -- --target <target>` for target packaging.
- Unit tests are the default and use `*.test.ts` for one owned behavior or interface. They may use real SQLite, filesystem, process, or OpenTUI adapters.
- Hosted OpenTUI surfaces use `*.tui.test.ts` (`bun run test-tui` in CI). Process-lifecycle and transport tests that spawn servers, PTYs, or kill fixtures use `*.proc.test.ts` and run by `bun run test-proc` in CI. `bun run check` and `bun run test` stay fast and deterministic: no child processes, no packaged binaries, and no wall-clock assertions — waits poll observable conditions with generous ceilings instead of asserting durations.
- `bun run test` owns all deterministic checks. Use `@effect/vitest` and `TestClock` for Effect behavior and time; use `bun:test` only when a Bun API requires it.
- Packaged-product verification lives in `bun run release-smoke` (after `bun run package`) and runs in the release workflow, not per push. Manual TUI acceptance uses the pilotty and agent-tty skills.
- Run focused tests while working, then `bun run check` and `bun run test` when the risk and time budget permit. Report what ran and what did not.
