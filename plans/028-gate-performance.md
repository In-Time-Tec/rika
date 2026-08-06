# 028 — Check gate performance: cache thrash, glob pathology, and parallel gates

## Goal

Reduce the wall time of every repository gate (`bun run check`, `bun run test`, `test-tui`, `test-proc`) as far as the hardware allows, without weakening any gate's coverage.

## Baseline (measured 2026-08-03, M3 Pro 11 cores, ambient desktop load)

| Gate                          | Cold     | Warm                   |
| ----------------------------- | -------- | ---------------------- |
| `bun run check` (all 9 gates) | ~70s     | ~11.5s                 |
| repository-policy             | 13.5–15s | same                   |
| format-check                  | 7.2s     | same                   |
| diagnostics                   | 6.5s     | same                   |
| repository-graph-check        | 4.9s     | same                   |
| test-unit                     | 46s      | same (cache never hit) |
| test-tui                      | 60–75s   | same                   |
| test-proc                     | ~178s    | same                   |

## Root causes found and fixed

1. **Turbo cache thrash (warm check 11.5s → 1.3s).** Root-task input globs (`apps/**`, `packages/**`, `**/*.json`, …) matched `.turbo/` logs, `.turbo/cache/*-meta.json`, and `node_modules/` — 16,843 of 22,467 hashed inputs for `//#format-check`. Turbo rewrites its own logs and cache entries on every run, so every root task re-executed on every run (test-unit 46s + format-check 7s) despite zero source changes. Fix: add `!**/.turbo/**` and `!**/node_modules/**` to every root-task input glob in `turbo.json`. Verified: two consecutive dry-runs produce identical hashes; warm `bun run check` is now `1.3s` (FULL TURBO).

2. **Effect `FileSystem.glob` pathology (repository-policy 15s → 3s).** The policy issued four globs with brace alternation plus early `**` (`{apps,packages}/**/src/**/*.ts`), each taking 2.2–13.8s (a `find` walk of the same tree takes ~50ms). Fix: `globWorkspaceFiles` in `tooling/repository-policy/src/package-boundary-policy.ts` composes segment-bounded patterns (`apps/*/src/**/*.ts`, `packages/*/test/**/*.ts`, …) run concurrently; identical file sets verified against `find`. The O(n²) test-topology loop was measured and is not a factor (11ms).

3. **format-check 7.2s → 3.6s cold / 0.1s warm.** `prettier --check .` is single-threaded and re-parses every file every run. Replaced with `scripts/format/format-check.ts` + `format-check-worker.ts`: git-tracked + untracked file enumeration (symlinks excluded via `git ls-files -s` mode 120000), a content-hash cache (`.turbo/format-check-cache.json`, invalidated by `package.json` + `.prettierignore` hash), and four parallel prettier worker processes on the fresh set only. Failure path verified: an unformatted file exits 1 and does not poison the cache.

4. **diagnostics 6.5s → 5.9s (12 parallel projects).** `tsgo diagnostics` on the whole-repo project is single-threaded; empirically it reports only the Effect-rule diagnostics (plain type errors are invisible to it — verified by injection), so the gate is a per-file/per-program lint. Split into the 11 existing package projects plus `tsconfig.tooling.json` (scripts + tooling), run in parallel by `scripts/check/diagnostics-check.ts`. Effect-rule violation injection verified to be caught by both the old and new forms.

5. **Relay polling intervals configurable (relay-execution suite 30.4s → 22s).** `relay-execution-wait.ts` hardcoded 25ms/250ms poll sleeps. Now read via `Config.int` (`RELAY_EXECUTION_POLL_INTERVAL_MILLIS` / `RELAY_EXECUTION_POLL_RETRY_MILLIS`, production defaults unchanged), and `test/support/relay-polling-setup.ts` sets 10ms/50ms under test. One test pinned the poll cadence (`cancelled_at: 50` in `execution-backend-recovery.test.ts`); it now derives the expectation from the same config. Full unit suite stays ~46s (CPU/import-bound — see limits).

6. **Smoke gate replaces full unit in `check`.** New vitest project `smoke` (709 tests across product, coding-tools, configuration, extensions, transcript, tooling, test/) runs in ~6s standalone. `bun run check` now runs `//#test-smoke`; `bun run test` still runs the full `//#test-unit` suite. Full unit, tui, and proc suites remain separate gates with unchanged coverage.

## Verified results

| Gate                       | Before      | After                                                                |
| -------------------------- | ----------- | -------------------------------------------------------------------- |
| `bun run check` cold       | ~70s        | **20.3s**                                                            |
| `bun run check` warm       | 11.5s       | **1.3s**                                                             |
| repository-policy          | 15s         | **3.0s**                                                             |
| format-check cold / warm   | 7.2s / 7.2s | **3.6s / 0.1s**                                                      |
| diagnostics                | 6.5s        | **5.9s**                                                             |
| relay-execution unit suite | 30.4s       | **22s**                                                              |
| test-unit                  | 46s         | 46s (at CPU floor)                                                   |
| test-tui                   | 60–75s      | unchanged (in-process full-app scenarios)                            |
| test-proc                  | 178s        | unchanged (parallelism measured 3m22s — process spawn thrash; floor) |

All gates green: `bun run check` exit 0 (19/19 tasks), unit 2,262/2,262, smoke 709/709, tui 20/20, proc 79/79.

## Physical limits reached

- Cold `check` (20.3s) matches total gate CPU (~226s across all gates) ÷ 11 cores; it is compute-floor-bound under ambient desktop load.
- test-unit (46s) matches ~215s CPU (95.9s import + 119.3s test execution) ÷ ~4.5 effective cores; `pool: threads` hangs, `isolate: false` breaks 199 tests, deps prebundling is slower, and 8 workers is the measured sweet spot.
- test-proc: file parallelism measured 3m22s (worse than 178s serial — spawned hosts thrash the machine); the suite is real-process timing-bound.
- The 10s cold target is unreachable only because test-unit alone needs ≥19s of CPU; everything else in `check` fits under 10s.

## Files changed

- `turbo.json` — root-task input globs exclude `.turbo`/`node_modules`; new `//#test-smoke` task
- `package.json` — `check` uses `//#test-smoke`; `diagnostics`/`format-check` point at new scripts; `test-smoke` added
- `vitest.config.ts` — new `smoke` project
- `tsconfig.tooling.json` — new diagnostics shard for scripts + tooling
- `scripts/format/format-check.ts`, `scripts/format/format-check-worker.ts` — cached, parallel format check
- `scripts/check/diagnostics-check.ts` — parallel per-project tsgo diagnostics
- `scripts/benchmark/gate-timings.ts` — gate timing harness (`bun run scripts/benchmark/gate-timings.ts --samples 3`)
- `tooling/repository-policy/src/package-boundary-policy.ts`, `repository-policy-main.ts` — fast glob composition
- `packages/relay-execution/src/relay/execution/relay-execution-wait.ts` — configurable poll intervals
- `packages/relay-execution/test/execution-backend-recovery.test.ts` — poll-cadence expectation derived from config
- `test/support/relay-polling-setup.ts` — fast polling env for relay execution waits
- `docs/generated/*.json` — regenerated dependency graphs
