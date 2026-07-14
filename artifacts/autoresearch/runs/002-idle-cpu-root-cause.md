# Run 002: Idle CPU Root Cause Isolation

Date: 2026-07-14

Status: diagnosis confirmed; code change pending Oracle review

Issue: [Rika #117](https://github.com/dallenpyrah/rika/issues/117)

## Fixed conditions

- Rika revision: `a67703464bca934f51037f2978d74c8631b2c67c`
- Host: macOS 26.1 arm64
- Bun: `1.3.5`
- Effect: `4.0.0-beta.93`
- Source TUI dimensions: `80x24`
- Isolated `HOME`, product SQLite, Relay SQLite, diagnostics, and deterministic model response
- Terminal state: deterministic Turn completed and Pilotty reported more than 11 seconds without PTY output before the terminal-idle sample

## Product reproduction

A fresh source TUI and its spawned resident reproduced the packaged failure:

| Process | CPU | RSS | State |
| --- | ---: | ---: | --- |
| Client | 38.5% | 172 MB | terminal static after completed Turn |
| Resident | 40.7% | 240 MB | terminal static after completed Turn |

Ten-second macOS samples are retained at:

- `raw/002-idle-cpu/client-cpuprof/client-terminal-idle.sample.txt`
- `raw/002-idle-cpu/client-cpuprof/resident-terminal-idle.sample.txt`

The profiled client and resident both stopped after `Ctrl+C`; no processes from this reproduction were left running.

## Boundary isolation

The following probes used the same installed Effect and Bun runtime:

| Probe | CPU |
| --- | ---: |
| `BunRuntime.runMain(Effect.never)` | 0.0% |
| `Effect.never` with Rika `Logging.layer` | 33.5% |

Evidence:

- `raw/002-idle-cpu/minimal-effect-never.ps.txt`
- `raw/002-idle-cpu/minimal-logging.ps.txt`

This separates the failure from an idle Effect runtime and reproduces it with the Rika-owned logging layer alone.

## Effect source evidence

`apps/rika/src/logging.ts` passes `batchWindow: 0` to `Logger.toFile`.

Both current `repos/effect/packages/effect/src/Logger.ts` and pinned `effect@4.0.0-beta.93` implement `Logger.batched` as:

```text
sleep(window) -> flush -> forever
```

`Logger.toFile` defaults to a 1,000 ms window when the option is absent. A zero window therefore creates a continuously runnable background fiber even when no log records exist.

## Geometric batch-window measurement

The direct `Logger.toFile` probe recorded:

| Batch window | CPU |
| ---: | ---: |
| 0 ms | 36.4% |
| 1 ms | 3.1% |
| 10 ms | 0.7% |
| 100 ms | 0.2% |
| 1,000 ms | 0.0% |

Raw table and samples:

- `raw/002-idle-cpu/logger-window-results.tsv`
- `raw/002-idle-cpu/logger-window-*.sample.txt`

## Conclusion

Fact: the Rika file logger's zero-duration batch window independently reproduces the sustained idle CPU load.

Conclusion: Rika owns the primary defect. This is valid Effect behavior for the requested zero-duration repetition, not evidence of an Effect scheduler defect.

Still to prove before keeping a change:

- the chosen positive window preserves normal-exit, typed-failure, interruption, SIGINT, and SIGTERM flush behavior;
- private permissions, rotation, abrupt-exit `.open.jsonl` evidence, and safe fields remain unchanged;
- the packaged client and resident meet a low idle-CPU budget in repeated before-and-after runs;
- no separate idle loop remains after the logger spin is removed.

An independent multi-lens Oracle review is running before implementation.
