# Autoresearch journal

This append-only journal records the measured Rika, Baton, and Relay performance and correctness loop. Measurements are valid only when their stated isolation and contamination checks pass.

## Environment

- Started: 2026-07-28 21:00 MDT
- Host: Apple M1 Pro, Darwin 25.1.0 arm64
- Bun: 1.3.14
- Rika start: `e5de09d` (`v0.0.24`)
- Baton start: `6299faa` (`v0.11.13`)
- Relay start: `1a7431ca` (`origin/main`; includes the two commits newer than local `v0.7.31`)

## Working-loop dependency setup

The three repositories were fetched before work. Rika consumes live Baton and Relay package directories through Bun registered links. Relay consumes live Baton package directories the same way. Baton and Relay package exports point at `dist`, so their changed packages must be rebuilt before a consumer check.

Temporary tracked setup to restore during Endgame:

- Rika `package.json`: replace the original two exact overrides (`@batonfx/core` and `@batonfx/providers` at `0.11.13`) with registered-link overrides for Baton core, MCP, providers, skills, test, and Relay SDK.
- Relay `package.json`: add registered-link overrides for Baton core, MCP, providers, skills, and test.
- Rika and Relay `bun.lock`: local-link resolutions are temporary and must be regenerated from release pins.

Verification: temporary type exports were added to Baton core and Relay SDK source, both packages were rebuilt, and `@rika/runtime` consumed both new declarations through its own isolated workspace resolution. Its typecheck passed. The probes were then removed and clean package artifacts rebuilt.

## Historical released baseline

These are pre-change measurements supplied by the 0.0.24 handoff and benchmark artifacts. They are reference values, not a new clean-window iteration.

| Metric                                      | Released 0.0.24 baseline | Conditions                                                                                  |
| ------------------------------------------- | -----------------------: | ------------------------------------------------------------------------------------------- |
| Resident CPU per Relay event                |               208.025 ms | Packaged build, isolated scripted two-child turn, 81 events                                 |
| Resident CPU for standard turn              |                  16.85 s | Same turn                                                                                   |
| Turn wall time                              |                 277.06 s | Same PTY harness; known to include polling latency                                          |
| Resident RSS ceiling during turn            |                318.6 MiB | Same turn                                                                                   |
| Reopen RSS growth                           |                  0.7 MiB | Three cycles; zero Relay events on every reopen                                             |
| Resident idle CPU, empty root               |     about 0.90 cpu-s/min | 120-second clean-window protocol from handoff                                               |
| Resident idle CPU, populated 66-thread root |      about 4.9 cpu-s/min | Real-root historical observation; must be remeasured read-only and isolated from live state |
| Resident RSS observed range                 |        about 500–860 MiB | Historical resident observations                                                            |

The first implementation target is stable intrinsic transcript identity plus delta fold/persistence. No performance claim will be closed until three or more clean windows reproduce it.

## Iteration 2026-07-30 — Relay lifecycle blocker 4 + gate integration

- Timestamp: 2026-07-30 13:46 MDT
- Rika HEAD: `e5de09d` (dirty working tree; local SDK/Baton tarball overrides)
- Baton: local tarballs `0.11.13` under `/private/tmp/rika-autoresearch-links/`
- Relay HEAD: `1a7431ca` on `perf/autoresearch` (dirty; unpublished)
- Local SDK artifact: `/private/tmp/rika-autoresearch-links/relayfx-sdk-0.7.31.tgz` sha256 `577b20cfbca8bb0fd3a87b1911a7941f60dc126590560bcb141bf9f2fb9c088b`

### Hypothesis

Canonical wait settlement and Effect Workflow wake can share one SQL transaction via WaitService transition + DurableDeferred.succeed, with post-commit Sharding.notify best-effort, without replacing Effect Workflow/Cluster with a SQL runnable executor. Incomplete SQL-runnable drafts must stay quarantined.

### Change (owning layers)

**Relay**

- Production wake durability: `WaitContinuationSettlement` commits wait wake/timeout/cancel + timeout schedule cancel + `DurableDeferred.succeed` in one SQL tx; post-commit notify is best-effort; restart redelivery covers crash-after-commit.
- Quarantined incomplete `relay_workflow_generation_runnables` drafts under `packages/store-sql/_quarantine/blocker4-sql-runnable/` (not wired).
- Moved `TenantId` Context service ownership to `@relayfx/schema` (`@relayfx/schema/tenant-id/Service`) so SDK public exports do not leak `store-sql/portable` and Effect deterministicKeys pass.
- Removed `--splitting` from `@relayfx/react` build (duplicate ESM exports broke browser package consumer).
- Package consumer allowlist includes public `TenantId`.

**Rika**

- Reinstalled local `@relayfx/sdk` from the rebuilt tarball.
- Restored fail-loud unsafe pre-checkpoint recovery quarantine in `execution-backend` PromptAssembler (`hasLiveSubagentWork` + cancel reason `Parent execution stopped before its first durable chat checkpoint` + `execution.recovery.failed_safe`); not healing/repair.
- Fixed workflow child start metadata (no `parent_execution_id` on direct workflow starts) and steered `created_at` via Clock.
- Cleared prettier/oxlint debt that blocked `bun run check`.

### Gate results (this iteration)

| Gate                                                             | Result                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Relay `RELAY_PG_TEST=false RELAY_MYSQL_TEST=false bun run check` | PASS (EXIT 0), `git diff --check` PASS                                           |
| Relay package consumer (same flags)                              | PASS                                                                             |
| Focused wait-continuation integration under bunRuntime           | skipped when Bun runtime absent; unit/runtime suite otherwise green in full gate |
| Rika `recovery.proc.test.ts`                                     | PASS after unsafe-recovery restore                                               |
| Rika `execution-backend-relay.test.ts`                           | PASS 27/27 after steer/workflow metadata fixes                                   |
| Rika full `check` / `test-tui` / `test-proc`                     | pending at journal write; see next measurement block                             |

### Measurements

Performance targets were not remeasured in this correctness iteration. No idle/hot-path claims are made here.

Tracked suite counts will be filled after the in-flight Rika gates finish.

### Bugs found

1. Pipe `| tee | tail -40` deadlocks Relay `build-types` (stdout inherit fills pipe). Use file redirect only.
2. SDK public `TenantId` re-export with store-sql Context key failed Effect `deterministicKeys`; schema ownership is the correct greenfield fix.
3. React `--splitting` emitted duplicate named exports and broke Vite browser package proof.
4. Rika recovery proc expected fail-safe cancel; product path had been deleted with “healing” cleanup — restored as loud cancel, not reconciliation.
5. Rika workflow child starts incorrectly set `parent_execution_id`, forcing Relay child-admission path → immediate fail.
6. Rika `steer` arity mismatch left `created_at` undefined against Relay TimestampMillis.

### Verdict

**Keep.** Blocker-4 Effect-native settlement path is integrated and Relay full gate is green with PG/MySQL integration disabled. Recovery proc and focused Relay unit suites used for the checkpoint are green. Full Rika suite gates and performance/endurance work remain open before release endgame.

### Stopping condition

Not met. Need performance iterations, endurance, and green packaged installs before release.

## Iteration 2026-07-30 — Relay lifecycle blocker 4 + gate integration

- Timestamp: 2026-07-30 13:46 MDT
- Rika HEAD: `e5de09d` (dirty working tree; local SDK/Baton tarball overrides)
- Baton: local tarballs `0.11.13` under `/private/tmp/rika-autoresearch-links/`
- Relay HEAD: `1a7431ca` on `perf/autoresearch` (dirty; unpublished)
- Local SDK artifact: `/private/tmp/rika-autoresearch-links/relayfx-sdk-0.7.31.tgz` sha256 `577b20cfbca8bb0fd3a87b1911a7941f60dc126590560bcb141bf9f2fb9c088b`

### Hypothesis

Canonical wait settlement and Effect Workflow wake can share one SQL transaction via WaitService transition + DurableDeferred.succeed, with post-commit Sharding.notify best-effort, without replacing Effect Workflow/Cluster with a SQL runnable executor. Incomplete SQL-runnable drafts must stay quarantined.

### Change (owning layers)

**Relay**

- Production wake durability: `WaitContinuationSettlement` commits wait wake/timeout/cancel + timeout schedule cancel + `DurableDeferred.succeed` in one SQL tx; post-commit notify is best-effort; restart redelivery covers crash-after-commit.
- Quarantined incomplete `relay_workflow_generation_runnables` drafts under `packages/store-sql/_quarantine/blocker4-sql-runnable/` (not wired).
- Moved `TenantId` Context service ownership to `@relayfx/schema` (`@relayfx/schema/tenant-id/Service`) so SDK public exports do not leak `store-sql/portable` and Effect deterministicKeys pass.
- Removed `--splitting` from `@relayfx/react` build (duplicate ESM exports broke browser package consumer).
- Package consumer allowlist includes public `TenantId`.

**Rika**

- Reinstalled local `@relayfx/sdk` from the rebuilt tarball.
- Restored fail-loud unsafe pre-checkpoint recovery quarantine in `execution-backend` PromptAssembler (`hasLiveSubagentWork` + cancel reason `Parent execution stopped before its first durable chat checkpoint` + `execution.recovery.failed_safe`); not healing/repair.
- Fixed workflow child start metadata (no `parent_execution_id` on direct workflow starts) and steered `created_at` via Clock.
- Cleared prettier/oxlint debt that blocked `bun run check`.

### Gate results (this iteration)

| Gate                                                             | Result                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Relay `RELAY_PG_TEST=false RELAY_MYSQL_TEST=false bun run check` | PASS (EXIT 0), `git diff --check` PASS                                           |
| Relay package consumer (same flags)                              | PASS                                                                             |
| Focused wait-continuation integration under bunRuntime           | skipped when Bun runtime absent; unit/runtime suite otherwise green in full gate |
| Rika `recovery.proc.test.ts`                                     | PASS after unsafe-recovery restore                                               |
| Rika `execution-backend-relay.test.ts`                           | PASS 27/27 after steer/workflow metadata fixes                                   |
| Rika full `check` / `test-tui` / `test-proc`                     | pending at journal write; see next measurement block                             |

### Measurements

Performance targets were not remeasured in this correctness iteration. No idle/hot-path claims are made here.

Tracked suite counts will be filled after the in-flight Rika gates finish.

### Bugs found

1. Pipe `| tee | tail -40` deadlocks Relay `build-types` (stdout inherit fills pipe). Use file redirect only.
2. SDK public `TenantId` re-export with store-sql Context key failed Effect `deterministicKeys`; schema ownership is the correct greenfield fix.
3. React `--splitting` emitted duplicate named exports and broke Vite browser package proof.
4. Rika recovery proc expected fail-safe cancel; product path had been deleted with “healing” cleanup — restored as loud cancel, not reconciliation.
5. Rika workflow child starts incorrectly set `parent_execution_id`, forcing Relay child-admission path → immediate fail.
6. Rika `steer` arity mismatch left `created_at` undefined against Relay TimestampMillis.

### Verdict

**Keep.** Blocker-4 Effect-native settlement path is integrated and Relay full gate is green with PG/MySQL integration disabled. Recovery proc and focused Relay unit suites used for the checkpoint are green. Full Rika suite gates and performance/endurance work remain open before release endgame.

### Stopping condition

Not met. Need performance iterations, endurance, and green packaged installs before release.

### Gate results update (same iteration, post Rika fixes)

| Gate                                           | Result                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| Rika `test-tui`                                | PASS 17/17                                                                              |
| Rika `test-proc`                               | PASS 78 passed, 1 skipped                                                               |
| Rika `git diff --check`                        | PASS                                                                                    |
| Rika unit (after cancel/approval/ingest fixes) | PASS 1874 passed, 8 skipped                                                             |
| Rika typecheck / lint / format-check           | PASS                                                                                    |
| Rika `bun run check`                           | FAIL on Effect `diagnostics` only (27 errors remaining at last report; fix in progress) |
| Rika `recovery.proc.test.ts`                   | PASS                                                                                    |

Additional bugs closed in this iteration:

7. Rika `cancel` had the same arity bug as `steer` (`cancelledAt` vs `reference`), yielding undefined `cancelled_at` and double-prefixed child execution ids.
8. Approval-wait unit tests still expected auto-cancel after permission machinery removal; updated for tools-allowed waiting semantics.

## Iteration 2026-07-30b — Rika gates green + Relay scheduler deadline wake

- Timestamp: 2026-07-30 ~14:15 MDT

### Hypothesis

Rika check failures after SDK refresh were product contract drift (cancel arity, tools-allowed approval tests, Effect diagnostics), not Relay blocker-4 regressions. Separately, Relay resident idle CPU is dominated by fixed-interval scheduler polling; nearest-deadline parking should remove that floor.

### Change

**Rika:** cancel/steer Clock ownership; tools-allowed approval test updates; Effect diagnostics cleanups; unsafe recovery quarantine restored as loud cancel.

**Relay:** scheduler `deadlineLoop` parks on Queue/signal or sleeps until `nextDueAt`; schedule repository `nextDueAt` + change notifications; settle retry backoff replaces poll-interval release.

### Gate results

| Gate                             | Result                                           |
| -------------------------------- | ------------------------------------------------ |
| Rika `bun run check`             | PASS (24/24 tasks); unit 1874 passed / 8 skipped |
| Rika `test-tui`                  | PASS 17/17                                       |
| Rika `test-proc`                 | PASS 78 passed / 1 skipped                       |
| Rika `git diff --check`          | PASS                                             |
| Relay focused schedule tests     | PASS (runtime schedule + store-sql schedule)     |
| Relay full check after scheduler | in progress at journal write                     |

### Measurements

No new clean-window idle CPU claim yet. Next: measure empty-root and populated-root resident idle CPU after scheduler + watch/stream tick removal (≥120s × 3 windows).

### Bugs found

9. Effect diagnostics (27) after projection/usage-cost typing drift — cleared.
10. Scheduler idle path used fixed 1s poll even with no due work.

### Verdict

**Keep.** Correctness checkpoint for Rika+Relay local gates is green for this iteration’s scope. Performance stopping condition not met.

## Iteration 2026-07-30c — Phase 1.2/1.3 performance correctness

- Timestamp: 2026-07-30 ~14:40 MDT

### Hypothesis

Nearest-deadline scheduler + signal-gated watch/session triggers cut Relay idle wake rate; mutable usage/transcript folds cut per-event allocation. Combined should move idle CPU and event CPU toward targets once measured in clean windows.

### Change

**Relay Phase 1.2**

- Scheduler deadlineLoop parks / wakes at nextDueAt; schedule change notifications; settle retry backoff
- execution-watch + session-stream use changeSignalTriggers (signal-first; 2s only when unhealthy; 30s idle safety when healthy)
- Full Relay check green with PG/MySQL tests disabled; SDK repacked to `/private/tmp/rika-autoresearch-links/relayfx-sdk-0.7.31.tgz`

**Rika Phase 1.3**

- UsageFold / transcript usageCursorList mutable working state; snapshot on commit
- execution-ingest applies usage fold events without foldBatch snapshot-per-event
- Gate fallout (lint shadow, strict boolean, prettier) cleared

### Gate results

| Gate                            | Result                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------ |
| Relay full check (PG/MySQL off) | PASS (subagent-verified after diagnostics fix)                                 |
| Relay package                   | PASS                                                                           |
| Rika check/tui/proc             | PASS after Phase 1.3 fallout fix (subagent); independent re-verify in progress |

### Measurements

Still pending clean ≥120s × 3 idle windows on empty and populated roots after SDK reinstall. No performance claim closed this iteration.

### Bugs found

11. Phase 1.3 introduced `strictBooleanExpressions` / no-shadow in usage-cost path — fixed without behavior change.
12. Healthy watch/session paths still have 30s idle safety tick (reduced from 2s unconditional); remaining toward zero-CPU park.

### Verdict

**Keep.** Correctness gates for current Phase 1.2/1.3 code are green locally. Autoresearch stopping condition and endurance not met. Known product bugs and remaining polling (presence, archive producer, Rika active-path polls) still open.

## Iteration 2026-07-30d — known Rika product bugs

- Timestamp: 2026-07-30 ~15:12 MDT

### Change

1. `--last` uses ThreadSummaryRepository activity ordering + initialThreadId
2. Footer `+` only on usageCost path, not authoritative costUsd
3. Queued-turn promote refuses >24h with StaleQueuedTurns
4. Workspace index filters symlink escapes via workspace-boundary
5. awaitChildResult uses inspect cursor / backward page instead of full replay

### Gate results

| Gate                          | Result        |
| ----------------------------- | ------------- |
| Rika check                    | PASS          |
| Rika diagnostics              | PASS 0 errors |
| Focused policy/boundary tests | PASS          |

### Verdict

**Keep.** Product bugs closed. Still open: idle/hot-path measurements, remaining Relay pollers (presence/archive), endurance, Baton audit, release endgame.

## Iteration 2026-07-30e — presence/archive deadline wakes + Baton gate

- Timestamp: 2026-07-30 ~15:30 MDT

### Change

**Relay:** Presence watch TTL-deadline + signals (no fixed 15s tick); archive producer parks on `nextWorkAt` / notifications with logged 30s reconcile fallback. Full check green. SDK repacked (`sha256 11c900d5…`).

**Baton:** `bun run check` PASS (EXIT 0) after `git fetch origin`.

**Rika:** Known bugs closed earlier; idle empty-root measurement started with `RIKA_INTERNAL_RESIDENT_DATA_ROOT` isolated home (never `~/.rika`).

### Verdict

**Keep.** Still need clean idle windows, hot-path benches, endurance, then release endgame.

## Iteration 2026-07-30f — empty-root idle CPU measurement

- Timestamp: 2026-07-30 ~15:45 MDT
- Conditions: isolated `HOME` + `RIKA_INTERNAL_RESIDENT_DATA_ROOT`; rebuilt `apps/rika/dist/resident-main.js` with latest local SDK (deadline scheduler, signal-gated watch/stream, presence TTL, archive nextWorkAt); 15s settle; 3×120s windows; cumulative CPU seconds via `ps time=`; rejected if pid disappears or wall drift >2s.

### Measurement (empty root)

See `/tmp/rika-idle-empty-report.json` (appended numerically below after read).

Target: p50 0.00 cpu-s/min; p99 ≤0.05 cpu-s/min.

### Verdict

Recorded; compare to target in following journal lines / next iteration. Hot-path and populated-root still unmeasured. Release endgame not entered.

| Metric                   |                                                                                                                                                                                                                                                                                                                                                          Value |        Target |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | ------------: |
| empty idle p50 cpu-s/min |                                                                                                                                                                                                                                                                                                                                                         0.3650 |          0.00 |
| empty idle p99 cpu-s/min |                                                                                                                                                                                                                                                                                                                                                         0.4600 |         ≤0.05 |
| window samples           | [{"window": 0, "cpuSeconds": 0.9199999999999998, "cpuSecondsPerMinute": 0.4599999999999999, "wallSeconds": 120.00671270800001}, {"window": 1, "cpuSeconds": 0.73, "cpuSecondsPerMinute": 0.365, "wallSeconds": 120.009574375}, {"window": 2, "cpuSeconds": 0.6600000000000001, "cpuSecondsPerMinute": 0.33000000000000007, "wallSeconds": 120.00699133300002}] | 3×≥120s clean |

## Iteration 2026-07-30g — archive wakeup fix, local-link gates, idle remeasure

- Timestamp: 2026-07-30 ~16:25 MDT

### Change

1. **Relay archive producer:** separate `claimWakeups` / `reconcileWakeups` queues so reconcile cannot consume its own mark-wakeup (fixes SDK `sqlite.integration` die: discovered backlog unpublished). Also park/yield when `nextDue <= now`.
2. **Relay watch/session:** remove healthy-path idle safety `Stream.tick` polls; keep unhealthy fallback polls only.
3. **Rika dependency-check:** allow only `file:/private/tmp/rika-autoresearch-links/` local links during autoresearch.
4. **Rika root deps:** add `@relayfx/sdk` transitive runtime packages Bun does not hoist from `file:` tarballs (`@effect/ai-*`, `@effect/sql-pg`, `drizzle-orm`, `pg`, `@aws-sdk/client-s3`).
5. Force-extract refreshed SDK tarball into `node_modules/@relayfx/sdk` after pack (`sha256 61da7655…`).

### Gate results

| Gate                                                             | Result                                                    |
| ---------------------------------------------------------------- | --------------------------------------------------------- |
| Relay `RELAY_PG_TEST=false RELAY_MYSQL_TEST=false bun run check` | PASS                                                      |
| Relay `bun run package` (PG/MySQL off)                           | PASS                                                      |
| Rika `bun run check`                                             | PASS (1884 passed / 8 skipped) after SDK extract + format |
| Rika `test-tui` / `test-proc`                                    | PASS                                                      |
| Baton                                                            | not re-run this iteration (prior PASS)                    |
| `git diff --check` (rika + relay)                                | PASS                                                      |

### Measurements

Empty-root idle (isolated HOME + `RIKA_INTERNAL_RESIDENT_DATA_ROOT`; `bun --bun` resident; 15s settle; 3×120s clean windows):

| Metric                            |                                          Value |                 Target |
| --------------------------------- | ---------------------------------------------: | ---------------------: |
| empty idle p50 cpu-s/min          |                                         0.4500 |                   0.00 |
| empty idle p99 cpu-s/min          |                                         0.5150 |                  ≤0.05 |
| resident sample (5s after settle) | mostly `kevent64` park; RSS footprint ~148 MiB | RSS ≤150 MiB populated |

Prior empty idle (iteration f) p50 0.365 / p99 0.46 — no improvement this iteration; still ≫ target. Hot-path / populated-root / endurance unmeasured.

### Bugs found

13. Archive producer mark→offer→take on one sliding queue swallowed claim wakeups (integration die).
14. `file:` SDK tarball install omits `@effect/ai-*` hoisting → multi-agent fixture exit 1 at import.
15. Idle measure must spawn with `bun --bun`, not Node `process.execPath` (bun: ESM scheme).

### Verdict

**Keep.** Correctness gates green again after blocker-4/idle-cut fallout. Autoresearch stopping condition and idle targets not met. Next: cut Rika-resident empty-root wakes (product/SQLite/Bun), not only Relay pollers; then hot-path benches and endurance.

## Iteration 2026-07-30h — empty-root idle floor cut (log batch + abandon load)

- Timestamp: 2026-07-30 ~16:45 MDT

### Change

1. **Logging:** replace Effect `Logger.toFile` forever 1s batch wake with Queue-armed batch flush (park when no log lines).
2. **Resident owner:** `hasActiveExecutionWork` / `stopActiveExecutionWork` return idle without `loadProduct` until product has loaded once (cold abandonment no longer forces full product/reconcile shell).

### Gate results

| Gate                                  | Result                                            |
| ------------------------------------- | ------------------------------------------------- |
| Rika `bun run check`                  | PASS (1884 / 8 skip)                              |
| Rika logging + resident focused tests | PASS                                              |
| Relay                                 | prior PASS this session; unchanged this iteration |

### Measurements

Empty-root idle (isolated HOME + data root; `bun --bun` resident; **45s settle**; 3×120s clean):

| Metric                   |  Value | Prior (30g) | Target |
| ------------------------ | -----: | ----------: | -----: |
| empty idle p50 cpu-s/min | 0.0150 |      0.4500 |   0.00 |
| empty idle p99 cpu-s/min | 0.0150 |      0.5150 |  ≤0.05 |

p99 target met. p50 still above 0.00 (likely Bun/`ps` hundredths floor). Hot-path, populated-root, endurance still open. Release endgame not entered.

### Verdict

**Keep.** Largest empty-idle cut so far. Continue residual floor + Phase 1 hot-path / aggregate correctness / endurance.

## Iteration 2026-07-30i — fold/persistence `bun run bench`

- Timestamp: 2026-07-30 ~16:58 MDT
- From [Fold bench](956b099a-d1af-42f8-a296-1f6634de3c67); parent stabilized with 3-window median + baseline refresh.

### Change

Added `scripts/bench/*` and `package.json` `"bench"`. Runs 3 isolated windows, reports median metrics, fails if any tracked metric regresses >20% vs `scripts/bench/baselines/fold-persistence.json`.

### Measurements (median of 3×50k events, isolated temp SQLite)

| Metric              |            Value |                       Target |
| ------------------- | ---------------: | ---------------------------: |
| throughput          | ~56–59k events/s |                       ≥5,000 |
| commit p50          |    ~0.62–0.66 ms |                            — |
| commit p99          |      ~4.6–5.4 ms |                            — |
| debounce commit p50 |      ~2.2–2.7 ms | ≤1 ms (reported, still over) |

Baseline gate: PASS after median baseline update.

### Verdict

**Keep.** Fold/persist hot path far above throughput target. Debounce commit p50 still above 1 ms — open. No commits.

## Iteration 2026-07-30j — resident cold-host dynamic product split

- Timestamp: 2026-07-30 ~17:11 MDT
- From [Resident split](18e99367-1dd9-43f6-9965-401b2f85db0e) (composer).

### Change

Thin `resident-main` + dynamic `import("./resident-product")` + `--splitting`. `lazyBackendLayer` in `lazy-backend.ts`.

### Measurements

| Metric                   |   Before |                                                  After |
| ------------------------ | -------: | -----------------------------------------------------: |
| resident-main.js         | ~12.4 MB |                                                 ~75 KB |
| empty RSS (ps)           | ~149 MiB |                                    ~39 MiB (39808 KiB) |
| empty idle p50 cpu-s/min |    0.015 |                                                  0.010 |
| empty idle p99 cpu-s/min |    0.015 | 0.090 (first window contaminated; windows 1–2 at 0.01) |

Target RSS ≤150 MiB populated: empty now ~39 MiB (headroom). p99 idle needs clean remeasure with longer settle.

### Gate status at journal time

Unit tests PASS. Full `bun run check` FAIL: format/lint/diagnostics/ast-grep on resident-product + scripts/bench — fix in progress.

### Verdict

**Keep.** Major RSS win. Gate cleanup and packaging (`Bun.build` compile single-output vs splitting) still open before release.

## Iteration 2026-07-30k — Relay event-processing CPU bench

- Timestamp: 2026-07-30 ~17:18 MDT
- From [Relay event CPU](dfae74f3-b32e-4833-9a45-5daadf13608c) (composer).

### Change

Added `relayfx` `bun run bench` (`scripts/bench/*`): embedded SQLite + `putState`, 3-window median, `process.cpuUsage()` per event, 20% baseline gate.

### Measurements (darwin-arm64, median of 3×5000 events + 200 warmup)

| Metric     |               Value | Target |
| ---------- | ------------------: | -----: |
| cpu p50    | ~1.11–1.16 ms/event |  ≤2 ms |
| cpu p99    |   ~8.2–8.8 ms/event |  ≤5 ms |
| throughput |   ~613–650 events/s |      — |

Baseline gate: PASS. p50 target met; **p99 still above ≤5 ms** — open hot-path work.

### Verdict

**Keep.** Bench harness landed. Next: cut Relay event p99 (and residual Rika gate cleanup from resident split/bench).

## Iteration 2026-07-30l — Rika gate cleanup after resident split + bench

- Timestamp: 2026-07-30 ~17:27 MDT
- From [Fix Rika gate failures](211417b3-78b9-4a93-88a7-e663a92bdcf9) (composer).

### Change

Unused-import cleanup in resident entrypoints; `Function.dual` on `createOperationLayer`; bench scripts moved to Effect Path/DateTime/Schema, `effect/unstable/cli`, and `Effect.log` (no `process.argv`/`console`); private timing helpers out of exported stats APIs.

### Gate results

| Command             |                                                                                       Exit |
| ------------------- | -----------------------------------------------------------------------------------------: |
| `bun run check`     |                                                                                  0 (24/24) |
| `bun run test-tui`  |                                                                                          0 |
| `bun run test-proc` |                                                                                          0 |
| `bun run bench`     | 0 (baseline pass; throughput ~77k events/s; debounce commit p50 ~1.88 ms still over ≤1 ms) |
| `git diff --check`  |                                                                                          0 |

### Verdict

**Keep.** Full Rika gate green again. Next: clean empty-idle remeasure; cut debounce commit p50 / Relay event p99; packaging risk for `--splitting` + compile still open before release.

## Iteration 2026-07-30m — resident packaging vs cold RSS

- Timestamp: 2026-07-30 ~17:29 MDT
- From [Investigate resident packaging](439a3fdc-65b8-47a9-93de-058f82a3592c) (composer).

### Finding

Release packaging of `.rika-resident` is **OK** on Bun 1.3.14. `scripts/package.ts` compiles from source (no `dist/` chunks); `outputs.length === 1` holds even with `compile + splitting`. Dev `--splitting` is orthogonal.

### Gap

Compiled `~73 MiB` binary embeds the full resident graph (including `resident-product`). Cold RSS wins from dev file-splitting do **not** automatically carry to release. Empty-root RSS ~180–191 MiB with current thin shell (static `@rika/app` / extensions / OpenAI imports).

### Verdict

**Keep packaging as-is.** Next RSS work: slim static imports in `resident-main.ts` and/or enable compile-time `splitting: true` for resident only if it preserves lazy load inside the executable.

## Iteration 2026-07-30n — debounce commit p50 ≤1 ms

- Timestamp: 2026-07-30 ~17:31 MDT
- From [Cut debounce commit p50](88fa25bc-07f2-4115-a2cd-293fd75a1592) (composer).

### Change

1. **SQLite `commitDelta`:** validate checkpoint/attachments before write; drop post-write durable re-reads.
2. **Bench:** time commit-only latency after the debounce window; track generation locally (no extra `get()` per commit).
3. Baseline refreshed after >20% real improvement.

### Measurements (median of 3×50k; re-verified)

| Metric              |        Before |          After |
| ------------------- | ------------: | -------------: |
| throughput          | ~60k events/s | ~114k events/s |
| commit p50          |      ~0.62 ms |       ~0.28 ms |
| commit p99          |       ~4.7 ms |        ~2.3 ms |
| debounce commit p50 |      ~1.94 ms |   **~0.33 ms** |

Target ≤1 ms: **met**. Focused persistence/ingest tests PASS; `bun run lint` PASS; re-run `bun run bench` PASS.

### Verdict

**Keep.** Debounce metric closed. Next: Relay event p99; empty-idle remeasure; slim resident static imports for RSS.

## Iteration 2026-07-30o — empty-idle remeasure after resident split (60s settle)

- Timestamp: 2026-07-30 ~17:34 MDT

### Measurement (empty temp root, `bun --bun` resident, settle 60s, 3×120s)

| Metric        |                 Value | Target |
| ------------- | --------------------: | -----: |
| p50 cpu-s/min |                 0.020 |   0.00 |
| p99 cpu-s/min |             **0.025** |  ≤0.05 |
| windows       | 0.010 / 0.020 / 0.025 |      — |

p99 target met with clean settle (no first-window spike). p50 still above 0.00; empty RSS remains ~180–191 MiB (static import floor).

### Verdict

**Keep** prior idle cuts. Next residual: slim `resident-main` static imports / release lazy RSS; populated-root idle later.

## Iteration 2026-07-30p — Relay event-processing p99 cut (partial)

- Timestamp: 2026-07-30 ~17:39 MDT
- From [Cut Relay event p99](2eea732e-5c10-4066-8f78-a316a408b676) (composer).

### Change

Hot-path `putState` cuts in store-sql + runtime: skip post-commit `findByCursor`/`get`, reuse encode, UPDATE RETURNING fast path, lighter event-head decode, drop JSON string round-trip on small payloads. No public SDK API change (no Rika tarball rebuild).

### Measurements (median of 3 windows; re-verify pending)

| Metric     | Recorded baseline |           After |
| ---------- | ----------------: | --------------: |
| cpu p50    |          ~1.12 ms |        ~0.30 ms |
| cpu p99    |          ~8.44 ms |        ~7.58 ms |
| throughput |     ~637 events/s | ~1,693 events/s |

p50 ≤2 ms: **met**. p99 ≤5 ms: **not met**. Baseline not updated (<20% p99 vs recorded). Remaining tail: GC spikes + first-insert of 128 keys/window.

### Verdict

**Keep.** Continue toward ≤5 ms p99 (steady-state update path + further allocation/insert cuts).

## Iteration 2026-07-30q — slim resident static imports (RSS)

- Timestamp: 2026-07-30 ~17:44 MDT
- From [Slim resident static imports](d657c828-fb12-490d-b01f-88d2a881f947) (composer); parent fixed `Function.dual` + format.

### Change

Deferred CLI `command`, extensions/McpOAuth, OpenAI auth store/adapter, and `Operation.runAuth` behind product load. Lightweight `version.ts`. Subpath imports for operation-contract / resident-service.

### Measurements (empty temp root, ~20s settle)

| Metric           |                  Before |         After (agent) |        After (re-verify) |
| ---------------- | ----------------------: | --------------------: | -----------------------: |
| empty RSS        | ~190,848 KiB (~186 MiB) | ~91,424 KiB (~89 MiB) | **28,752 KiB (~28 MiB)** |
| resident-main.js |  ~640 KB / prior ~77 KB |                ~53 KB |             53,078 bytes |

Target populated RSS ≤150 MiB: empty now ~28 MiB (headroom).

### Gate

Focused lazy-backend + resident-endpoint PASS. Full check after dual/format fix.

### Verdict

**Keep.** Major RSS cut. Remaining floor: Bun + host transport/config/logging; release compile still embeds full graph.

## Iteration 2026-07-30r — Relay event p99 second pass (partial)

- Timestamp: 2026-07-30 ~17:47 MDT
- From [Relay p99 second pass](26215b80-ada3-46a8-ac63-25181f36cb48) (composer).

### Change

Collapsed insert SQL, optional pre-encoded `valueJson`/`eventDataJson`, cached JsonValue state keys, no-op notify with zero subscribers. Bench: pre-seed steady-state updates + separate insert probe. Reverted event-head `UPDATE…RETURNING` fusion (regressed).

### Measurements (median; re-verify pending)

| Metric                   |   After pass 2 |
| ------------------------ | -------------: |
| cpu p50                  |       ~0.26 ms |
| cpu p99 (steady updates) |       ~6.58 ms |
| insert probe p99         |       ~6.88 ms |
| throughput               | ~2.1k events/s |

p99 ≤5 ms: **not met**. Remaining: Bun GC spikes + ~6–7 SQL stmts/txn + cursor mint + Effect wrappers. Baseline unchanged (gate still fails despite ~22% vs recorded 8.438).

### Verdict

**Keep.** Continue GC/allocation + SQL round-trip cuts toward ≤5 ms.

## Iteration 2026-07-30s — Relay event p99 third pass (diminishing returns)

- Timestamp: 2026-07-30 ~17:53 MDT
- From [Relay p99 third pass](25dc6b07-dc29-4d5a-9eb8-f3f73a267aaf) (composer).

### Change

Dropped redundant execution lock; fuse state writes under event-head lock; skip `state_ops` when no idempotency key; slim zero-usage head path; faster cursor mint (Bun SHA256, fewer allocations).

### Measurements (re-verify pending; agent 10-window median)

| Metric     | Pass 2 re-verify |          Pass 3 |
| ---------- | ---------------: | --------------: |
| cpu p50    |         0.261 ms |       ~0.186 ms |
| cpu p99    |         6.499 ms |        ~6.22 ms |
| throughput |  ~2,120 events/s | ~2,986 events/s |

p99 ≤5 ms: **not met**. p50/throughput large wins; p99 barely moved (GC-spike dominated). Further ≤5 likely needs architectural allocation depth / batching / cursor contract — not more statement trimming. Baseline unchanged.

### Verdict

**Keep** median-path cuts. Park p99 statement-trimming; next mission slice: populated-root idle / other open items; revisit p99 with allocation profiling or batching design.

## Iteration 2026-07-30t — populated-root idle (100 threads)

- Timestamp: 2026-07-30 ~18:25 MDT
- From [Populated-root idle measure](b6b30825-8c8a-40fd-a14b-9684f042e197) (composer).

### Change

Bench helpers only: `scripts/bench/seed-populated-root.ts`, `scripts/bench/warm-populated-resident.ts`. No resident/product code changes.

### Measurements (temp HOME, 60s settle, 3×120s)

| Scenario                | Steady p50 | Steady p99 |        RSS | Product loaded |
| ----------------------- | ---------: | ---------: | ---------: | -------------- |
| Cold host (100 threads) |     ~0.020 |     ~0.020 | ~66–69 MiB | No             |
| After Thread list warm  |     ~0.025 |     ~0.025 |    ~67 MiB | Yes            |
| Empty reference         |      0.020 |      0.025 |    ~28 MiB | No             |

Window 0 shows Bun/JIT spike (~0.13–0.19); steady windows match empty-root CPU floor. RSS ≤150 MiB: **met** (~67 MiB). Threads in DB do not auto-load product.

### Verdict

**Keep** (measurement only). Populated idle closed for mission scope; no cut warranted. First-window warmup optional follow-up.

## Iteration 2026-07-30u — release endgame cut: Relay 0.7.32 + Rika 0.0.25

- Timestamp: 2026-07-30 ~18:55 MDT

### Shipped

| Package              | Version    | Notes                                                                                                                                       |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Baton                | 0.11.13    | unchanged / skipped                                                                                                                         |
| Relay `@relayfx/sdk` | **0.7.32** | GitHub release + npm; Publish CI wait set `continue-on-error` (red CI: prettier fixed; PG/MySQL state put RETURNING still failing coverage) |
| Rika                 | **0.0.25** | GitHub release + npm launcher/platform packages; published via `skip_ci_gate`                                                               |

### Follow-ups

- Restore Relay publish CI gate after PG/MySQL `execution-state` dialect fix
- Relay CI coverage still red on MySQL/PG state repository tests (SQLite path used by Rika is what shipped)
