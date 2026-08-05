# Rika Performance Goal

Rika stays responsive and memory-flat as a Thread grows. Ordinary interaction cost does not scale with Thread age, archived event count, or historical token count.

These are release-binary stretch targets on Apple Silicon at 120×36. Measurements use an isolated data-root copy and report client, server, and combined resources separately. A result passes only when the supported performance runner produces the evidence; moving work to another process or machine does not count as removing it.

## Responsiveness

| Metric                                    |                                      Target |
| ----------------------------------------- | ------------------------------------------: |
| Warm launch to interactive frame, p95     |                                     ≤150 ms |
| Cold launch to interactive frame, p95     |                                     ≤300 ms |
| Keystroke to frame, p95 / p99             |                              ≤8 ms / ≤16 ms |
| Scroll or navigation frame, p95 / p99     |                           ≤12 ms / ≤16.7 ms |
| Thread picker open, p95                   |                                      ≤25 ms |
| Thread picker navigation, p95             |                                      ≤12 ms |
| Thread preview load, p95                  |                                      ≤40 ms |
| Current-Thread selection                  |     ≤16 ms and no persistence or Baton read |
| Large persisted Thread open, p50 / p95    |                           ≤100 ms / ≤150 ms |
| Incremental execution event to frame, p95 |                                      ≤25 ms |
| Sustained rendering                       | 60 frames per second without dropped frames |

## Resources

| Metric                                     |      Target |
| ------------------------------------------ | ----------: |
| Combined local idle CPU, mean / peak       |   ≤1% / ≤3% |
| Active navigation CPU, mean / peak         | ≤10% / ≤20% |
| Combined local idle RSS                    |    ≤350 MiB |
| Combined RSS with 5,000 messages loaded    |    ≤500 MiB |
| RSS growth after 100 open and close cycles |     ≤10 MiB |
| RSS growth after one hour idle             |      ≤5 MiB |
| Server restart recovery, p95               |     ≤500 ms |

## Bounded work

- Persisted usage display reads one aggregate and never replays execution history.
- A reconciled terminal Thread replays zero Baton events and traverses zero historical tokens when reopened.
- One new execution event performs constant or logarithmic work plus work proportional to changed visible transcript units.
- Initial Thread, picker, preview, and backward-scroll reads are bounded pages.
- Normal frame rendering performs no database work.
- Restart recovery resumes from persisted cursors and does not replay from genesis unless persisted state is missing or invalid.
- Re-selecting the current Thread transfers zero transcript bytes and performs no projection rebuild.

## Large-Thread evaluation

The standard large evaluation contains at least 5,000 messages, nested Child Runs, five million historical tokens, and a persisted transcript larger than one MiB. It measures cold launch, warm launch, initial open, reconciled reopen, current-Thread selection, picker and preview interactions, scrolling, streaming updates, restart recovery, one-hour idle behavior, CPU, RSS, allocation growth, database reads, Baton replay counts, payload bytes, frame latency, and dropped frames.

The performance runner emits versioned JSON with workload identity, machine and terminal dimensions, sample counts, percentiles, process-local measurements, pass or fail for every target, and any unsupported measurement. Unsupported or missing measurements never pass.
