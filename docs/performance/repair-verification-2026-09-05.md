# Rika 0.12.9 repair verification

The local repair candidate upgrades Generalist from 0.46.1 to 0.61.0 and addresses the control failures identified in the [interaction audit](interaction-audit-2026-09-05.md). This document records local evidence. Production rollout, published installation, and live acceptance remain pending.

## Changes and evidence

| Problem                                                                   | Change                                                                                                                                                                       | Verification                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Cancellation exhausted the SQL pool or left a suspect connection reusable | The Effect PostgreSQL patch sends cancellation through a separate, bounded control connection and evicts interrupted or failed transaction clients.                          | Real PostgreSQL tests cover one-connection pool saturation, interrupted COMMIT, and successful connection reuse.               |
| Replayed projections could stay below the saved revision                  | Replay snapshots rebase from the saved revision; store writes compare their base revision before replacement.                                                                | Replay and competing-watcher regressions, with both memory and PostgreSQL stores.                                              |
| Cancellation lost its target after admission                              | The client retains the exact submission-to-command identity across admission and repeated cancellation.                                                                      | Admission/rejection and newer-submission race regressions.                                                                     |
| Runner reconnects retried permanent failures                              | Policy/fencing failures leave the reconnect loop; transient failures use bounded exponential backoff and reset after a healthy interval.                                     | Process tests exercise permanent and transient socket failures and native tool cancellation.                                   |
| Noninteractive follow-ups could miss their terminal result                | Durable admission receipts include the Turn ID; the client accepts authoritative snapshots and acknowledges consumed cursor positions.                                       | Snapshot-before-receipt and omitted-admission-event regressions. Protocol version is 9.                                        |
| Thread lists performed per-Thread authorization and project reads         | Authorization batches IDs under the existing policy; project filtering happens in the summary query before its limit.                                                        | Owner, user, device, revoked-grant, foreign-project, and missing-project cases.                                                |
| Missing provider cache fields appeared as zero hits                       | Usage tracks the cohort with reported counters; the UI shows unknown or partial coverage explicitly.                                                                         | Projection, SQL replacement, and terminal formatting regressions.                                                              |
| Spans started after the operation had finished                            | Observability opens and parents the span around the operation; API logs use structured JSON.                                                                                 | A controlled clock verifies actual elapsed work and failure-preserving telemetry.                                              |
| Mac tool supervision used incompatible shell assumptions                  | macOS uses a zsh supervisor; subprocess HOME comes from the selected user.                                                                                                   | SIGINT, missing executable, output descriptor isolation, and native subprocess tests.                                          |
| Switching away from large histories retained their virtual index          | The virtual document clears references on short/empty histories, Thread changes, and destruction. Thread-list presentation avoids redundant decoding and content assignment. | Existing renderer suites plus a before/after garbage-collection probe: old history retained before the fix, released after it. |
| Help advertised unsupported stream flags                                  | Removed unsupported stream options and dead parsing paths.                                                                                                                   | Noninteractive command validation tests and packaged help verification.                                                        |

## Generalist database upgrade

The released 0.61.0 PostgreSQL schema installer accepts a new database but rejects the schema version used by 0.46.1. A pinned dependency patch adds one bounded upgrade from version 4 with checksum `c9ff31038d2758d3398dc9836880285b23a0428fd0a08c4c0752757a6e647d4a` to version 9. Unknown versions, mismatched checksums, and dirty metadata remain rejected.

The upgrade runs under a transaction and advisory lock. It adds the current host-session, wake-event, schedule, permission-rule, and memo tables, along with the new fork, checkpoint, and host-session columns. It retains existing Runs and journal records. Historical StructuredOutput events and ChildLinked records without inheritance metadata remain decodable without rewriting their recorded facts.

The fixture was generated with the released 0.46.1 Runtime and contains completed, admitted, and interrupted work. Tests verify rejection of unknown metadata, rollback after a DDL failure, concurrent upgrade calls, idempotence, unchanged historical event JSON, execution of admitted work, and explicit retry of an interrupted operation. The patch also restores claim eligibility for previously attempted root Runs after that explicit retry; never-activated admissions remain ineligible.

These patches belong to the installed dependency boundary. Rika does not gain a second execution journal or query Generalist tables in product code. A simple application rollback to 0.46.1 will reject version 9 metadata; recovery must account for the database version. Railway's API pre-deploy command invokes the schema installer, so pushing this candidate to production also performs this upgrade.

## Local release checks

- `bun run check`: 19 tasks passed.
- `bun run test`, using isolated PostgreSQL: 2,062 tests passed across 289 files.
- `bun run test-proc`: 52 passed, 3 skipped across 18 files.
- The two PostgreSQL-dependent process files were then run with the isolated database: all 3 tests passed, including worker contention/fencing and browser review. Only the opt-in Mac process sampler remains unrun in this suite.
- `bun run test-tui`: 69 passed across 32 files.
- Generalist PostgreSQL suite: 20 passed, including the legacy database upgrade.
- The rebuilt darwin-arm64 archive has the required executable and INSTALL inventory. Its executable reports `rika v0.12.9`; all 79 help paths exit successfully (89.68–99.89 ms, one sample per path). Unsupported stream flags are absent.

Logs and diagnostic probes are under the ignored `.agents/state/repair-20260905/` directory. Generalist 0.61.0 was rechecked against the npm registry on September 5, 2026; its Effect peer matches the repository's 4.0.0-rc.112 pin.

## Performance limits and remaining acceptance

The latest source diagnostic uses 5,005 transcript items, 100 warmup interactions, 100 measured interactions, and 100 streamed updates. First render was 56.99 ms, picker-open p95 0.88 ms, and stream-update p95/p99 7.43/8.52 ms. These are deterministic renderer measurements, not live production percentiles.

RSS was 365.72 MiB after loading and grew 24.03 MiB during the measured interactions. JavaScript heap growth was 0.21 MiB. RSS therefore still exceeds the audit's 350 MiB loaded target and 10 MiB growth target; the wider built-in 500 MiB ceiling must not be mistaken for passing the stricter audit. The isolated unauthenticated client exited before idle sampling, so idle CPU and client RSS are not established by this diagnostic.

The release still needs production queue/edit/dequeue/steer/cancel/reconnect and noninteractive acceptance, actual Orb preparation, installed Mac resource measurements, and refreshed latency distributions. Full command-to-draw correlation, complete provider wire/cache coverage, and the audit's long-duration and concurrency targets are not certified by these local suites. The original audit budgets remain unchanged.
