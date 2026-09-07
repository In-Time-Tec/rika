# TUI v2 rendering measurements

Measured September 7, 2026 on Linux x64, Bun 1.4.0, a four-logical-CPU AMD EPYC
machine with approximately 16 GB RAM, OpenTUI 0.5.10, and Solid 1.9.12. The
headless renderer uses a 216 × 62 terminal-cell viewport. Cases ran sequentially
in fresh processes. The baseline source and benchmark workload and timing procedure are
preserved in commit `75bd1f7beda7a0592e8c8f665634a75f64bc3503`.

These are synthetic UI workloads, not executions of real models, subagents, or
workspace tools. Raw measurements are in [tui-v2-results](tui-v2-results/).
The [harness instructions](../../apps/tui-v2/test/performance/readme.md) explain
the counters and commands. UI regression tests separately verify actual rich
text, history retention, selection, mouse scrolling, and bounded mounted rows.
The benchmark also rejects accidental `[object Object]` rendering.

## Paired baseline comparison

Each case uses eight streaming Threads, up to 32 streaming child cards and 32
streaming tool outputs, and 15 iterations. Each iteration runs three update
bursts: one alone, one while opening modes, and one while opening the palette.
Every burst edits, dequeues, and appends a pending instruction. History mixes
tool calls, user messages, and assistant messages so it cannot collapse into one
tool group. No timing samples were discarded as warm-up.

| History / children / queued | Version   | Mutation p95 | Update + flush p95 | Palette + streaming p95 |  Mount | Peak sampled RSS |
| --------------------------- | --------- | -----------: | -----------------: | ----------------------: | -----: | ---------------: |
| 100 / 10 / 10               | Baseline  |     53.91 ms |           75.76 ms |                77.21 ms | 160 ms |        284.0 MiB |
| 100 / 10 / 10               | Optimized |     11.21 ms |           33.61 ms |                38.47 ms | 154 ms |        212.5 MiB |
| 1,000 / 100 / 100           | Baseline  |    360.63 ms |          453.49 ms |               498.06 ms | 575 ms |        600.1 MiB |
| 1,000 / 100 / 100           | Optimized |     10.86 ms |           35.92 ms |                39.61 ms | 240 ms |        256.5 MiB |
| 10,000 / 1,000 / 1,000      | Baseline  |       Failed |             Failed |                  Failed |      — |                — |
| 10,000 / 1,000 / 1,000      | Optimized |     17.87 ms |           55.97 ms |                50.98 ms | 636 ms |        430.4 MiB |

At the medium scale, p95 update-plus-flush latency improved approximately 12.6×,
and peak sampled process RSS fell approximately 57%. The original large case
failed while creating native syntax styles; its [failure log](tui-v2-results/baseline-large.failure.log)
is preserved rather than represented as a numeric result. The optimized large
case completed every interaction.

Update-plus-flush includes OpenTUI scheduling and frame pacing. It is not pure
JavaScript execution time; the separate mutation column measures synchronous
reactive work. Palette timings include the preceding streaming burst, key
dispatch, and flush, but exclude the frame assertion. RSS includes Bun and the
complete synthetic client state, not just mounted terminal elements.

## Extreme scale

Both extreme cases retain **100,000 history items**, **1,000 subagent cards**,
**1,000 pending instructions**, and **32 streaming Threads**. Each burst updates
1,000 tool outputs, 1,000 child cards, and 32 assistant replies, in addition to the
three queue operations. Each case runs 30 iterations and 90 bursts. The `oldest`
case updates the earliest tools; `newest` targets the latest tool indices,
including the mounted history window. Both keep all underlying history.

| Tool placement | Mutation p95 | Update + flush p95 | Mode + streaming p95 | Palette + streaming p95 |  Mount | Peak sampled RSS |
| -------------- | -----------: | -----------------: | -------------------: | ----------------------: | -----: | ---------------: |
| Oldest         |    123.52 ms |          159.82 ms |            146.98 ms |               167.91 ms | 1.90 s |      1,298.5 MiB |
| Newest         |    107.88 ms |          193.01 ms |            189.66 ms |               201.75 ms | 1.85 s |      1,255.4 MiB |

All cases completed and verified the mode and palette responses. This is not a
60-fps claim at extreme load: a burst containing over 2,000 updates can still
take hundreds of milliseconds to display. It establishes a measured stress
envelope, not an absolute maximum or a guarantee for arbitrarily large tool
outputs, single groups, or histories.

## Idle work and implementation changes

A separate two-second medium-scale static observation recorded **zero native
frames** and 22.32 ms of process CPU time. With animation enabled but all activity
headers clipped by the large queue, it also recorded **zero native frames** and
70.98 ms of CPU time. The animation clock still ticks; clipped headers no longer
invalidate native text buffers. The same clipped-animation observation on the
baseline produced 19 frames and consumed 698.63 ms of CPU time. Visible-header animation and scrolling are
covered by a native rendering regression. The small workload can have one
initial settling frame, so these results are not a claim that startup is idle.

The measured fixes are:

- Stable per-item projections and lazy tool-body parsing keep streamed output
  from rebuilding unrelated groups or parsing unmounted history.
- Shared contextual-sidebar and width memos remove repeated full-history scans
  from every rich-text block. The CPU profile identified these scans as a hot path.
- Native rich-text buffers avoid per-chunk Solid node churn, while explicit
  palette conversion and attribute handling preserve colors and formatting.
- A 250-group history window prevents native resource exhaustion without deleting
  history. Detail expansion defaults are computed in linear time.
- The command palette mounts at most 25 rows at reference height and does not
  build thousands of queued-turn actions while closed.
- Completed and clipped headers stop changing animation glyphs, and rich-text
  blocks share the transcript width instead of adding redundant resize listeners.

See [the rendering tradeoffs](../tradeoffs/tui-v2-rendering.md) for navigation and
memory costs. The raw samples include runtime, hardware, workload counts, native
counters, CPU, and memory details. Repeat the same cases on target hardware before
treating these single-machine measurements as a latency budget.
