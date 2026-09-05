# Rika 0.12.9 repair verification

The local repair candidate upgrades Generalist from 0.46.1 to 0.61.1 and addresses the control failures identified in the [interaction audit](interaction-audit-2026-09-05.md). This document records local evidence. Production rollout, published installation, and live acceptance remain pending.

## Changes and evidence

| Problem                                                                   | Change                                                                                                                                                                       | Verification                                                                                                                   |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Cancellation exhausted the SQL pool or left a suspect connection reusable | Generalist sends cancellation through a separate, bounded control connection and evicts interrupted or failed transaction clients.                                           | Real PostgreSQL tests cover one-connection pool saturation, interrupted COMMIT, and successful connection reuse.               |
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

## Current database contract

The release uses a fresh Generalist database. Old Thread and execution history is reset before deployment; no legacy schema upgrade or historical event decoder is maintained.

PostgreSQL connection cleanup belongs in Generalist source and is consumed through its released `layerClientPool` API. Rika carries no dependency patches. Cancellation, failed COMMIT eviction, healthy reuse, and streamed queries have dedicated database regressions.

## Local release checks

- `bun run check`: 19 tasks passed.
- `bun run test`, using isolated PostgreSQL: 2,058 tests passed across 289 files.
- `bun run test-proc`, using isolated PostgreSQL: 54 passed and 1 skipped across 18 files. Only the opt-in Mac process sampler remains unrun in this suite.
- `bun run test-tui`: 69 passed across 32 files.
- The rebuilt darwin-arm64 archive has the required executable and INSTALL inventory. Its executable reports `rika v0.12.9`; all 79 help paths exit successfully (89.68–99.89 ms, one sample per path). Unsupported stream flags are absent.

Logs and diagnostic probes are under the ignored `.agents/state/repair-20260905/` directory. The published Generalist 0.61.1 package is built from commit `c5e879c8800d1062d429f9de02ab9f8d02c5bef3`; its Effect peer matches the repository's 4.0.0-rc.112 pin. Its GitHub release workflow passed, and the npm tarball SHA-256 matches the locally verified artifact (`d45ec9831b79218507611f095c965eba75a3e6636a3b6c2680514883b523c7ca`).

## Performance limits and remaining acceptance

The latest source diagnostic uses 5,005 transcript items, 100 warmup interactions, 100 measured interactions, and 100 streamed updates. First render was 56.99 ms, picker-open p95 0.88 ms, and stream-update p95/p99 7.43/8.52 ms. These are deterministic renderer measurements, not live production percentiles.

RSS was 365.72 MiB after loading and grew 24.03 MiB during the measured interactions. JavaScript heap growth was 0.21 MiB. RSS therefore still exceeds the audit's 350 MiB loaded target and 10 MiB growth target; the wider built-in 500 MiB ceiling must not be mistaken for passing the stricter audit. The isolated unauthenticated client exited before idle sampling, so idle CPU and client RSS are not established by this diagnostic.

The release still needs production queue/edit/dequeue/steer/cancel/reconnect and noninteractive acceptance, actual Orb preparation, installed Mac resource measurements, and refreshed latency distributions. Full command-to-draw correlation, complete provider wire/cache coverage, and the audit's long-duration and concurrency targets are not certified by these local suites. The original audit budgets remain unchanged.

### Additional packaged and memory-region probes

The packaged binary's standard diagnostic measured 292.66 MiB loaded RSS and 35.42 MiB interaction growth, with picker-open p95 0.28 ms and streamed-update p95 5.11 ms. A separate run using Bun's reduced-memory mode measured 311.42 MiB loaded RSS and 18.66 MiB growth, with streamed-update p95 5.81 ms. Both fail the growth target, so this experiment does not justify changing the release's runtime configuration. These are individual exploratory runs, not a repeated comparison establishing a reliable improvement.

A separate source-renderer probe captured macOS `vmmap -summary` at the loaded and interactions-completed boundaries. Physical footprint changed from 131.8 to 132.1 MiB. The resident portion of Memory Tag 240 grew from 193.6 to 220.8 MiB, while that region's dirty memory decreased from 104.3 to 103.2 MiB. JIT resident code grew by only 48 KiB. This points toward allocator residency contributing to RSS growth rather than a comparably sized increase in retained application data. It does not establish the allocation owner, prove a long-term plateau, or replace the RSS acceptance target. Probe output is saved as `vmmap-loaded.txt` and `vmmap-interactions-completed.txt` in the repair evidence directory.

After these diagnostics exited, the Mac process table contained no Rika executable processes.
