# Synthetic rendering benchmark

This bounded, offline workload mounts the real Solid `App` in OpenTUI's released
test renderer at 216 columns by 62 rows. It does not run models, tools, network
requests, workspace operations, or the hosted runtime. A real Solid store backs
the `Client` interface; unsupported interaction commands deliberately fail.

Run each case in a **fresh process** from `apps/tui-v2`, using the repository's
pinned Bun version:

```sh
bun --preload @opentui/solid/preload test/performance/benchmark.ts --scale small --iterations 20 > baseline-small.json
bun --preload @opentui/solid/preload test/performance/benchmark.ts --scale medium --iterations 20 > baseline-medium.json
bun --preload @opentui/solid/preload test/performance/benchmark.ts --scale large --iterations 20 > baseline-large.json
```

Run cases sequentially on an otherwise idle machine. Start small. The harness
does not launch the larger cases automatically. Default iterations are 10;
`--iterations` accepts 1–100. `--threads` accepts 1–32 (default 8), `--streams`
accepts 1–1000 (default 8), and `--idle-ms` accepts 0–5000 (default 250). Effect
limits a case to 120 seconds at cooperative yield points. For hard protection
against a synchronous native stall, run the process with an external deadline.

Animation defaults off. Use `--animate --idle-only --idle-ms 2000` for an
animation-only observation without mutation or interaction samples, and run the
same command without `--animate` for the static idle comparison.

| Scale   | History items | Child/subagent cards | Pending instructions |
| ------- | ------------: | -------------------: | -------------------: |
| small   |           100 |                   10 |                   10 |
| medium  |         1,000 |                  100 |                  100 |
| large   |        10,000 |                1,000 |                1,000 |
| extreme |       100,000 |                1,000 |                1,000 |

`--stream-placement oldest` remains the default and updates the earliest tool
calls, preserving previous baselines. `--stream-placement newest` selects the
final tool calls instead, exercising recent history retained by a bounded render
window. The counts and every other operation are identical between placements.
Whether all selected calls are mounted depends on the renderer's current window
and the number of child cards following the history; this is a position selector,
not a guarantee that every updated row is visible in the viewport.

Extreme cases are opt-in and should be run sequentially with an external deadline:

```sh
bun --preload @opentui/solid/preload test/performance/benchmark.ts --scale extreme --threads 32 --streams 1000 --iterations 30 --stream-placement oldest > extreme-oldest.json
bun --preload @opentui/solid/preload test/performance/benchmark.ts --scale extreme --threads 32 --streams 1000 --iterations 30 --stream-placement newest > extreme-newest.json
```

History mixes tool calls with user/assistant messages so it cannot collapse into
one uninterrupted tool group. The selected Thread holds this history, child
cards, a streaming assistant reply, and the pending queue. Other Threads each
hold a streaming reply. Every burst updates all Thread replies and up to
`--streams` child cards and tool-call outputs/statuses in a Solid batch, modeling deterministic coalesced
concurrent updates rather than independently scheduled agents. Replies append
chunks; child status text changes at each checkpoint. The queue edits its last
instruction, dequeues its first instruction, and appends a new instruction every
burst, keeping its total length fixed.

Each iteration measures an update burst plus flush, then mode and command-palette
opening during further bursts. Each overlay is closed and flushed before the
next measurement. Opening is verified in the rendered character frame; assertion
capture is outside the timed interval. Input samples include the preceding
stream mutation, key dispatch, and flush, so they are conservative combined
interaction latency, not OS keyboard-event latency. No samples are discarded as
warm-up; raw samples let a reviewer analyze that distinction explicitly.

One JSON object is written to stdout. Diagnostic warnings stay on stderr. The
output includes runtime versions, CPU model/count, available/total memory,
viewport and exact workload counts, seeding and mount-to-flush times, raw and
p50/p95/max update/input times, separate synchronous mutation and frame-flush wait
times, native stats after every iteration, CPU user/system
microseconds, wall time, sampled RSS bytes, final process memory, and process
high-water RSS in KiB. Native timing fields retain the installed library's units
and names; they are not normalized into milliseconds or terminal I/O throughput.

Idle is a bounded no-mutation observation with animation controlled by `--animate`. It reports
both frames during the sleep interval and frames caused by the final test-driver
flush, along with raw native counters before/after. This distinguishes an idle
scheduler from the test driver's explicit frame work. RSS sampling is not a full
allocation profile; the process high-water mark also includes Bun startup and
module loading. Total CPU/wall measurements include seeding, mount, idle,
interactions, and frame assertions, but exclude final JSON encoding and teardown.

Compare multiple runs on the same runtime/hardware before drawing conclusions.
This harness intentionally imposes no machine-dependent performance thresholds.
