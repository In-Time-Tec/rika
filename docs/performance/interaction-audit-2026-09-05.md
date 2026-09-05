# Rika interaction performance and control audit — 2026-09-05

## Conclusion

**Prioritize hosted execution correctness and control-state recovery before tuning the renderer or buying more Railway capacity.** The production incident includes a cancelled PostgreSQL COMMIT followed by reuse of the same aborted backend connection. A separate controlled tmux test reproduced a pending row that survived cancellation, edit/dequeue attempts, and Thread reselection, alongside repeated projection-revision conflicts for that test Thread.

The Mac renderer is fast in the deterministic workload, but memory growth and idle animation CPU still need work. First-message latency also includes significant Rika overhead: a measured one-line response took 8.78 seconds, while its hosted model-attempt telemetry reported 2.061 seconds. These are different measurements; the remaining approximately 6.72 seconds includes orchestration, transport, projection, and rendering, not a measured database-only duration.

This document records an audit and implementation plan. No product fix or deployment is implied by these results.

## Scope and evidence

- Installed CLI: **Rika 0.12.8**, packaged darwin-arm64, Bun 1.4.0.
- Checkout: `37d8f906f740bc306037916411ee2272017901a1`.
- Production API: matching commit, deployment `19aed66c-8319-4056-b9ff-6545e695a456`, status SUCCESS, created 2026-09-05 16:19 UTC. SUCCESS is deployment status, not proof of functional health.
- Railway project `a7720974-295a-45bc-b999-f57f6527a830`, production environment `d5c3da40-a968-4f76-b9bd-280d361a05f3`; one API replica in `us-west2`.
- Generalist: checkout pins **0.46.1**; npm and GitHub reported **0.61.0** as latest during this audit.
- User incident: screenshots around 10:51–10:53 MDT, or 16:51–16:53 UTC. The user's initial 15–30 second delay is an observation, not a stopwatch sample collected by this audit.
- Live probes used a separate tmux server, `rika-perf-20260905`, 150 columns × 45 rows. Test workspace: `.agents/state/perf-audit-20260905/workspace`, with its own Git root.
- First nested-folder probe resolved to the parent checkout and reported another Runner owner. Its Runner-conflict results are excluded from the isolated baseline.
- Screens, timestamped observations, scripts, CLI inventory, local performance JSON, test output, and selected sanitized Railway evidence are under `.agents/state/perf-audit-20260905/`.
- The pre-existing untracked `prompt-caching-audit.md` was preserved. Its core telemetry findings were checked against source; current OpenAI and Anthropic documentation was fetched independently. Generalist did not resolve to a relevant Context7 library; official release notes and source were used for the migration assessment.
- Root AGENTS.md references feature docs and local acceptance/testing skills that are absent from this checkout. Live tests therefore used the already-published install and tmux as requested.

### Measurement limits

Most live paths have **one exploratory sample**, not a statistically defensible p95. Tmux capture polling was approximately 0.2–0.25 seconds for message/control probes and 0.05 seconds for navigation probes, plus command overhead. Reported visible-transition times are upper bounds at that sampling resolution. They are not input-device-to-display measurements from Ghostty.

Local log durations use Rika's own instrumentation. Model-attempt duration comes from semantic event timestamps; the wall-clock time at which its log is printed can lag execution. Pretty-printed Railway log records interleave, so arbitrary adjacent lines must not be treated as a reliable structured record.

Production inspection was read-only. Live product tests created test Threads and submitted short prompts, including bounded sleeps in the dedicated test workspace. Unrelated user Threads were not controlled. There was no load test, production SQL query, migration, release, upgrade, restart, or deployment. Full Orb preparation and one-hour soak tests were not performed.

## Measured baseline

| Interaction or resource                         | Observed baseline                                                     | Evidence / interpretation                                                                                                   |
| ----------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Installed CLI help tree                         | 79 paths, all exit 0; 108.68–124.59 ms                                | `cli-help-tree.json`; one sample per path, not a latency percentile                                                         |
| Doctor / native tools list / diagnostics status | 145 / 144 / 151 ms                                                    | `cli-baseline.json`; doctor explicitly does not test server health                                                          |
| Isolated TUI first draw                         | 53 and 55 ms                                                          | Process-start to first-draw local log timestamps, two launches                                                              |
| Connection ready                                | 3.80 and 4.38 s after process start                                   | Two isolated launches; separate from first draw                                                                             |
| Initial Thread attach                           | 498 and 468 ms                                                        | Local `hosted.attach` spans                                                                                                 |
| Background Thread-catalog refresh               | 14.44 and 18.92 s                                                     | `hosted.attach_refresh`; forked after attachment, **not** a blocking startup span                                           |
| First one-line response                         | 8.78 s to visible `FIRST_OK`                                          | `observations.jsonl`, `first-40.txt`; already-connected client                                                              |
| First Turn worker queue wait                    | 1.337 s                                                               | API `hosted.queue_wait.observed`, test Turn `48c0e564-105c-4ff8-9ae6-140cafa65e6b`                                          |
| First model attempt                             | 2.061 s; 1,064 input / 6 output tokens                                | Hosted model terminal event; not provider time-to-first-token                                                               |
| Prompt to visible shell-tool start              | 11.72 s                                                               | Controlled `sleep 45` scenario; 45 seconds of requested sleep is excluded from startup latency                              |
| Pending text echo                               | Visible by 0.414 s                                                    | `control-queue-local.txt`; local provisional state                                                                          |
| Pending durable-looking row                     | Approximately 5.10 s after Enter                                      | `Queueing…` became `Queued ·`; rendering does not independently prove persistence                                           |
| Steering text echo                              | Visible by 0.412 s                                                    | Still displayed as `steering:` at 2.4 s; this sample was subsequently cancelled, so it does not prove delivery to the model |
| Cancel running shell tool                       | Visible cancelled by 3.911 s                                          | `control-cancel-15.txt`; no repeated-cancel error in this healthy-path sample                                               |
| Pending work after that cancellation            | Still shown minutes later, including after reselection                | Persistent failure; corresponding test Turn emitted repeated stale-projection warnings                                      |
| Queue edit                                      | Composer entered edit mode by 16.6 ms                                 | Saving the unchanged text returned to the row; this is not proof that a changed edit persisted                              |
| Dequeue                                         | No visible removal within 3 s, or 10 s after explicitly selecting row | Failed observation; exact admission/delivery status remains unresolved                                                      |
| Command palette                                 | Visible by 11.7 ms                                                    | One tmux capture sample                                                                                                     |
| Thread switcher                                 | Visible by 17.4 ms; preview changed by approximately 0.52 s           | Cached catalog already available                                                                                            |
| New Runner Thread                               | Welcome view by 2.21 s                                                | UI action; not time to first model output                                                                                   |
| Select existing test Thread                     | Transcript by 0.752 s                                                 | Short history; pending-row inconsistency persisted                                                                          |
| New Orb Thread                                  | Welcome view by 2.54 s                                                | Metadata creation only; no prompt, no E2B preparation benchmark                                                             |
| Noninteractive stream mode                      | Rejected in approximately 120 ms                                      | Help exposes `--stream-json`; validation says execution does not support stream output                                      |
| Plain noninteractive follow-up                  | No completion within 40 s                                             | Process timed out; cannot claim prompt was rejected or cancelled server-side                                                |
| Reopen after process exit                       | Prior test transcript restored                                        | `reopen.json`; exact visible timing can be recomputed from captures                                                         |
| Test TUI process, empty/welcome activity        | 306.7 MiB RSS; sampled CPU mean 9.75%, peak 18.9%                     | Ten `ps` samples over about 5 s; animation/background traffic active, not a quiet one-hour idle average                     |

### Local rendering benchmark

`rika diagnostics performance` exercised 5,005 transcript items, 834 Child Runs, four tools per child, 100 streamed updates, and 100 interaction samples after warmup. The OpenTUI test renderer reported:

| Metric                  | Result                 | Existing target |
| ----------------------- | ---------------------- | --------------- |
| Initial render          | 42.52 ms               | ≤150 ms         |
| Picker open p95         | 0.734 ms               | ≤25 ms          |
| Picker navigation p95   | 0.768 ms               | ≤12 ms          |
| Scroll p95              | 0.096 ms               | ≤12 ms          |
| Stream update p95 / p99 | 4.68 / 5.03 ms         | ≤25 / ≤16 ms    |
| Render p95              | 0.160 ms               | ≤16.7 ms        |
| Loaded RSS              | 280.23 MiB             | ≤500 MiB        |
| RSS interaction growth  | **30.86 MiB — failed** | ≤10 MiB         |
| Heap interaction growth | 0.413 MiB              | ≤10 MiB         |

The diagnostic's overall result was false. Several live-process and persisted-history metrics are explicitly unsupported by that synthetic workload. Do not present the renderer benchmark as proof that hosted control works or that real-terminal frame delivery meets a percentile SLO. RSS growth with low retained-JS-heap growth merits native/render-cache investigation; one sample does not establish a leak.

### Additional warm-path and retry observations

A later TUI follow-up after reopening the first test Thread remained at **Sending for the entire 40-second capture**. Ctrl+C then left it at Waiting for the following 10 seconds; terminal cancellation was not confirmed. This is a failed warm-path sample, not a successful 40-second response. The first test Thread's earlier transcript reopened in approximately **3.01 seconds**.

The user's original process (PID 212) recorded **332 `runner.socket.reconnecting` events during 17:27:00–17:27:59 UTC**, approximately 5.53 per second. This count is from that process's local diagnostic log, not inferred from interleaved Railway records. It establishes sustained reconnect churn, not its exact trigger or the number of distinct sockets. That original process was not stopped or otherwise controlled by this audit.

## Runtime findings

### 1. Cancelled COMMIT and aborted-connection reuse — P0

Confirmed production sequence on PostgreSQL backend PID 221653:

```text
10:52:36.666 MDT  COMMIT
└── ERROR: canceling statement due to user request
    └── Same backend continues receiving requests
        ├── BEGIN → current transaction is aborted
        ├── transcript read → current transaction is aborted
        ├── Runner-admission read → current transaction is aborted
        └── worker queries → current transaction is aborted
            └── errors still observed at 10:52:54
```

This is stronger evidence than a generic infrastructure-load hypothesis. It does **not** establish which caller sent the cancellation, or that the user's Ctrl+C directly cancelled COMMIT.

Installed `@effect/sql-pg` implementation evidence:

- `node_modules/@effect/sql-pg/dist/PgClient.js:491`: cancellation uses `SELECT pg_cancel_backend(pid)` through the pool, with a five-second bound.
- `PgClient.js:220`: reserved-connection finalization releases the client; its captured error comes from the connection's error event.
- `node_modules/effect/dist/unstable/sql/SqlClient.js:104`: transaction wrapper commits or rolls back under an uninterruptible mask; failed commit is converted to a defect. A delayed database cancellation can still affect a server-side COMMIT independently of a fiber's interruptibility.

**Leading hypothesis:** cancellation timing and connection reuse allow an aborted transaction to return to circulation. Reproduce the exact boundary locally before assigning the fix to Rika, Effect, or Generalist. Other candidate causes include transaction-context leakage and concurrent use of a reserved connection. Do not remove fencing, idempotency, or transaction isolation to make this faster.

### 2. Projection conflict and stuck pending row — P0

Live reproduction, test Thread `ed178488-f68b-4ee4-a2cc-f8f89bfe3c90`:

1. Submit a bounded shell sleep and wait until the tool is visibly running.
2. Enter a second prompt, then Ctrl+S a steering instruction.
3. Ctrl+C while the shell is still active.
4. Tool reaches cancelled in 3.91 s; pending row remains.
5. Attempt edit/save and dequeue; switch to a new Thread and select the test Thread again.
6. Pending row remains. Logs for test Turn `97606a99-70df-481d-8e1c-77a88eceb6ce` repeatedly report stale projection revision, beginning around 17:11:27 UTC and continuing past 17:16:30 UTC.

Source path:

```text
Generalist Run events
└── packages/product/src/execution/projection/watch.ts
    ├── read stored checkpoint
    ├── consume projection change
    └── TranscriptRepository.commitProjection()
        └── packages/product-store/src/transcript/sql-writes.ts
            ├── compare projection/base revision
            └── no matching write → "stale"
                └── watch.ts:101 → RepositoryError
                    └── retry/backoff and reconnect
```

The generic watch recovery has a 15-minute silence threshold and retry bounds, but the observed repeated conflict did not reconcile promptly. The cancellation implementation calls `drainQueued` after cancellation (`packages/product/src/operation/interactive/turn/control.ts:348`); a silently preserved queue is not sufficient evidence of an intentional pause policy.

A stale read projection must not make accepted product work impossible to understand or control. Re-read the authoritative checkpoint on conflict, discard obsolete projector work, and resume from the latest compatible state. Determine whether duplicate watchers, revision reset, terminal reconciliation, or stale closure state creates the conflict. Retain Generalist execution authority.

### 3. Repeated cancellation errors in the user's screenshot — P0

The source has a concrete route to the exact displayed error:

```text
Ctrl+C
└── keyboard-picker.ts: unresolved submitted draft?
    ├── yes → Cancel { submissionId, threadId }
    └── commands.ts: cancellationTarget()
        └── pendingSubmitCommandIds no longer contains submissionId
            └── OperationUnavailable
                "This action is unavailable in the current Thread"
                    └── execution.ts: CancelFailed
                        ├── cancelPending = false
                        └── append another error block
```

The failure reducer does not itself reconcile the stale draft, busy state, or authority. This explains why repeated presses can repeat the same error. The exact vanished identity in the user's original process was not instrumented, so treat this as a source-supported race hypothesis, not a captured state dump.

Steering also captures a target Turn; PostgreSQL steering admission rejects a target that is no longer active (`packages/product-store/src/turn/postgres/steering-admission.ts:89`). Preserve the text and return a typed outcome when the target completes. Do not silently steer the next Run. Show a deliberate “Send as next Turn” recovery action.

### 4. Reclaim and reconnect churn — P0/P1

API samples around 17:04:54–17:05:00 UTC repeatedly name the same Run IDs in `hosted.run_claim.success` and show frequent Runner WebSocket closures with code 1008. These existed while the no-tool benchmark was running. The audit's dedicated Runner also experienced one lease expiry and reconnect.

Repeated claims do not prove duplicate model calls or duplicate tool side effects. Add claim-to-progress and close-reason telemetry, inspect durable wait/readiness state, and stop hot retries of unchanged unavailable work. Retryable transport loss, permanent policy rejection, stale fencing, and an unavailable executor need different handling.

The concrete inner Runner retry path is `packages/remote-execution/src/host/session/foreground-runner.ts:350`: while a saved session exists, a connection error is logged, the loop sleeps **250 ms**, and `Effect.forever(connection)` tries again. This inner path does not apply an increasing backoff or distinguish a permanent policy/fencing rejection before retrying. It can bypass the useful backoff at the outer Runner-service layer. Classify terminal rejection, invalidate/re-admit stale sessions where appropriate, and use bounded jittered retries for transient failures. Add a test that a permanently rejected session cannot generate an endless four-attempts-per-second loop per connection.

The hosted worker fallback interval is 30 seconds (`apps/api/src/hosted/application.ts:58`). This is a fallback behind notifications, not a mandatory delay on every request. Generalist worker concurrency is eight; Turn and command worker concurrency are 32. Product PostgreSQL is configured with a maximum of ten connections. This justifies measuring pool wait and contention; concurrency values alone do not prove saturation.

Railway one-hour snapshots: API CPU average 1.074, maximum 1.372 in the metric's CPU units; memory average 0.985 GB, maximum 1.726 GB. PostgreSQL CPU average 0.273, maximum 0.437; memory average 0.723 GB, maximum 1.022 GB. Resource limits/throttling and database lock durations were not obtained. These snapshots do not justify blaming CPU exhaustion or treating a larger instance as the fix.

### 5. Slow catalog refresh and missing latency attribution — P1

```text
Thread list HTTP handler
└── apps/api/src/http-api/threads/controller.ts: listThreads
    ├── authorize owner
    ├── ThreadSummaryRepository.list()       up to 100 rows
    └── Effect.filter(candidates)
        └── authorizeThread() per candidate

Project-filtered list
└── apps/api/src/hosted/thread/application.ts: threads
    └── readThread() per summary to filter project
```

This is a source-level N+1 authorization/filtering concern, consistent with multi-second background catalog refresh. Preserve authorization semantics while pushing authorized/project filtering into bounded queries or using a batched access check. Do not just add unrestricted parallel queries against the existing pool.

First-message timings also demonstrate an attribution gap. The first Turn waited 1.337 seconds in the Turn-worker queue, then reached its observed Run claim about 0.25 seconds after the Turn claim. End-to-end elapsed time was much longer than the model attempt. Instrument the missing preparation, scheduling, projection, and delivery intervals before selecting the next optimization.

### 6. CLI surface and observability gaps — P1

- All 79 help paths parse. Help correctness does not imply operation correctness.
- `apps/rika/src/command/root/noninteractive.ts:validateRunInput` advertises but rejects stream flags, workspace overrides, and ephemeral execution in this flow. Align help and validation, or implement supported behavior deliberately.
- A plain `rika run --thread ...` follow-up timed out after 40 seconds. Its client was stopped by the bounded probe; hosted admission and final disposition were not established.
- A recovery-inspection attempt using a Turn identifier as a Run identifier returned 404. Do not assume these identities are interchangeable; expose the actual Execution link in diagnostics.
- Existing logs already expose useful stages, but pretty multiline output interleaves and model terminal telemetry retains totals without cache breakdown. Emit one structured record per event and keep event execution time distinct from observation time.

## Prompt caching: target the right metric

The footer's `ctx 1%` measures context-window occupancy, **not prompt-cache efficiency**. The separate Context & Usage panel showed `Cached 0%` for the short cancelled test. That alone cannot establish the original Thread's real provider hit rate.

Verified source boundaries:

```text
Provider usage
└── Generalist ModelAttemptCompleted
    ├── packages/execution/src/projection/usage.ts
    │   └── input total / cacheRead / cacheWrite, optional counters
    ├── packages/execution/src/engine/runtime-telemetry.ts
    │   └── telemetry keeps input/output totals only
    └── apps/rika/src/interactive/controller/feed-projection.ts:115
        └── missing cacheRead becomes 0
            └── context-details.ts rounds read / total to an integer percent
```

Fix missing-as-zero and retain coverage before using cache percentages to make performance decisions. Keep these metrics separate:

- **Token reuse:** `sum(cache_read_tokens) / sum(total_input_tokens)` over a clearly defined cohort with known counters.
- **Request hit rate:** requests with a positive cache read divided by requests with known cache-read status. Also report eligible-only versus all-request rates.
- **Coverage:** fraction of attempts with an authoritative breakdown. Unknown must remain unknown; show failure/interruption coverage separately.
- **Cache writes:** newly cached tokens are not reads. Include their latency and cost in the appropriate provider accounting.

For a warm request with cached prefix `C` and newly processed suffix `D`, 99% reuse requires `C >= 99 × D`. Example: 99,000 cached tokens plus 1,000 new tokens is 99%; 10,000 plus 1,000 is 90.9%. Cold requests and evolving tool results lower the all-traffic ratio. Never inflate prompts to improve a dashboard number.

[Current OpenAI documentation](https://developers.openai.com/api/docs/guides/prompt-caching) requires exact prefix reuse and distinguishes model generations. GPT-5.6+ documents a 1,024-visible-token minimum and `prompt_cache_options.ttl: "30m"`; older models use different thresholds/retention controls. Stable `prompt_cache_key` helps routing but does not guarantee a hit. Verify the actual endpoint and SDK support before forwarding options. Rika's account-authenticated route is not automatically covered by public API-key endpoint guarantees.

[Anthropic's usage documentation](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) distinguishes uncached `input_tokens`, cache reads, and cache creation; its total input denominator is their sum. Normalize each provider separately. Installed Generalist already adds Anthropic/Bedrock wire markers. The earlier audit's OpenRouter marker-namespace concern requires a synthetic wire test before a second caching layer is added.

Caching implementation plan:

1. Record actual provider/model/authentication kind, purpose, attempt identity, total/read/write/uncached counts, missing fields, compaction epoch, and latency. Deduplicate by authoritative attempt ID.
2. Keep instructions and tool schemas ordered and stable; append request-specific guidance, user text, and tool results after stable content. Record privacy-safe prefix-change diagnostics rather than full prompts.
3. Compare the final serialized request across two synthetic calls, not just source prompt assembly. Check account endpoint behavior and option acceptance explicitly.
4. Benchmark cold first request, sequential warm reuse, changed suffix, changed prefix, compaction, route fallback, expiry, and concurrent children as separate cohorts. Finish warmup before measuring warm fan-out.
5. Use **≥99% eligible warm request hits** as a stretch target; use **≥99% token reuse only for a controlled workload where prefix/suffix arithmetic permits it**. Report organic traffic honestly, including cold starts and large tool outputs. Do not advertise 99% fleet token reuse as a universal SLO.

## Prioritized implementation plan

| Order | Work and owner                                                                   | Concrete exit criteria                                                                                                                                                                                                                                                           |
| ----- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-A  | Database cancellation isolation: API composition + upstream SQL/runtime boundary | Deterministic small-pool tests interrupt reads, BEGIN, COMMIT, rollback, and lease renewal; next independent transaction succeeds; broken clients are rolled back or evicted before reuse; original error and ambiguous commit outcome preserved                                 |
| P0-B  | Projection recovery: product projection + product-store                          | Concurrent watchers and stale base revisions rebase from current checkpoint without duplicate transcript units/usage; terminal state converges; no identical conflict retry loop beyond bounded recovery                                                                         |
| P0-C  | Pending/steer/cancel reconciliation: hosted session + terminal                   | Cancel races before admission, after admission, after completion, during reconnect, and during Thread switch preserve correct IDs and user text; no repeat-error trap; typed accepted/already-terminal/unavailable outcomes; durable queue edit/dequeue works after cancellation |
| P0-D  | Reclaim/reconnect control: execution + Runner transport                          | Distinguish unavailable work from runnable work; repeated claims make progress or back off; permanent 1008/policy failures do not reconnect in a tight loop; leases and tools remain fenced                                                                                      |
| P1-A  | Trace the full interaction path: shared observability contract                   | One command ID links local feedback, admission, application, worker claim, model/tool start, projection, push and draw; structured logs preserve source timestamp and observation timestamp                                                                                      |
| P1-B  | Catalog and launch path: API read model + CLI                                    | Batched authorized listing; bounded/paged results; visible local UI does not wait for catalog; startup/preparation spans account for the first-message gap                                                                                                                       |
| P1-C  | Cache truth and stable wire requests: execution provider boundary + UI           | Unknown remains unknown; complete counters pass replay/provider normalization tests; exact synthetic wire reuse verified for each supported route                                                                                                                                |
| P1-D  | Generalist 0.61 migration assessment and isolated implementation                 | Released API compatibility map, matching Effect peers, product/Run boundary retained, identical control/load benchmark on old and new release; green unit/TUI/proc suites and packaged acceptance                                                                                |
| P2    | Mac memory/animation and command surface                                         | Bound caches; quiet idle stops unnecessary animation/render work; RSS plateau shown over repeated cycles; help describes actual supported flags                                                                                                                                  |

Do P0-A through P0-D before interpreting a faster benchmark as a successful fix. Their regression cases define the upgrade gate. A small targeted fix and a dependency migration can be separate reviewable changes; no production mutation is required to prepare either.

### Generalist upgrade: reuse capabilities without moving product authority

[Generalist 0.47](https://github.com/In-Time-Tec/generalist/releases/tag/v0.47.0) changes its PostgreSQL driver boundary; [0.49](https://github.com/In-Time-Tec/generalist/releases/tag/v0.49.0) adds jittered retries and cache-aware compaction; [0.58](https://github.com/In-Time-Tec/generalist/releases/tag/v0.58.0) introduces the stable server API; [0.59](https://github.com/In-Time-Tec/generalist/releases/tag/v0.59.0) adds mailbox policies; [0.60](https://github.com/In-Time-Tec/generalist/releases/tag/v0.60.0) expands inspection; [0.61](https://github.com/In-Time-Tec/generalist/releases/tag/v0.61.0) is the current release checked here.

The server exports a Host-backed HTTP/SSE/WebSocket boundary and generated client. Assess it behind `packages/execution`; Rika must retain Hosted Owner authorization, Thread/Pending Turn semantics, Runner/Orb placement, and product projections. A Generalist Session is not a replacement name for a Rika Thread. Remove wrapper code only after mapping ownership, replay, idempotency, authentication, cancellation receipts, and transport behavior. Release notes are not evidence that a specific incident is fixed.

## Aggressive performance and reliability budgets

These are **proposed release gates**, not measured achievements. Use source-monotonic spans within each process, distributed trace IDs across processes, and end-to-end client timers. Separate normal warm service from startup, provider delay, and intentional queued waiting.

| Boundary                                          | p50 target | p95 target             | p99 / invariant                                                     |
| ------------------------------------------------- | ---------- | ---------------------- | ------------------------------------------------------------------- |
| Keypress → local echo / provisional row           | ≤16 ms     | ≤50 ms                 | ≤100 ms                                                             |
| Process launch → first draw                       | ≤75 ms     | ≤150 ms                | ≤250 ms                                                             |
| Launch → authenticated control ready              | ≤750 ms    | ≤1.5 s                 | ≤3 s                                                                |
| Enter → durable command admission                 | ≤150 ms    | ≤300 ms                | ≤750 ms                                                             |
| Admission → runnable worker starts                | ≤75 ms     | ≤200 ms                | ≤500 ms, absent intentional capacity wait                           |
| Local new Thread → selected/ready                 | ≤500 ms    | ≤1 s                   | ≤2 s                                                                |
| Existing short Thread selection → usable history  | ≤200 ms    | ≤500 ms                | ≤1 s                                                                |
| Thread catalog refresh                            | ≤250 ms    | ≤500 ms                | ≤1 s for 100 visible summaries                                      |
| Queue edit/dequeue → authoritative result         | ≤150 ms    | ≤300 ms                | ≤750 ms                                                             |
| Steering → durable receipt                        | ≤150 ms    | ≤300 ms                | ≤750 ms; application separately measured at next supported boundary |
| Cancel → durable receipt                          | ≤150 ms    | ≤300 ms                | ≤750 ms                                                             |
| Cancel → native tool stopped / terminal reflected | ≤500 ms    | ≤1 s                   | ≤2 s for cancellable native tools                                   |
| Rika-owned overhead before/after model            | ≤500 ms    | ≤1 s                   | ≤2 s; report provider time separately                               |
| Simple warm text prompt → first text              | ≤2 s       | ≤3 s                   | ≤5 s on a pinned, available route                                   |
| Stream event → drawn update                       | ≤16 ms     | ≤50 ms                 | ≤100 ms                                                             |
| Reconnect → reconciled short Thread               | ≤500 ms    | ≤1 s                   | ≤3 s after transport is available                                   |
| Quiet client CPU / idle RSS                       | —          | <1% CPU / <200 MiB RSS | Plateau after warmup; long-history budget separate                  |
| 5,000-item transcript                             | —          | <350 MiB RSS           | <10 MiB growth after repeated interaction cycles                    |

Reliability gates: zero lost/duplicated prompts or tool side effects in the fault-injection suite; 100% idempotent replay tests; zero stale cancellation-target retries after an authoritative terminal outcome; no permanently stranded pending rows; ≥99.9% terminal-attempt telemetry coverage in an observed production window. Report cache-field coverage independently.

For a release comparison, collect at least 100 samples per warm path under a stated concurrency and history size, keep raw distributions, and repeat across multiple time windows. Use larger samples (for example 1,000+) before relying on p99. Include errors and timeouts in the report instead of dropping them. Test 1, 8, and 32 simultaneous controls in isolated environments before production load testing. Do not divide a tiny successful sample into impressive-looking percentile claims.

## Acceptance matrix still needed

The audit exercised live submit, queue, steering, cancellation, edit, dequeue, palette, mode/context panels, Runner/Orb Thread creation, selection, process exit/reopen, and CLI validation. It did not certify every mutating operation merely because help parsed.

Required follow-up coverage includes cancellation around every admission/commit boundary, duplicate delivery, stale Thread versions, queued steering during target completion, interrupt-and-send with terminal extended-key encoding, large persisted-history opens, missing Runner, missed LISTEN/NOTIFY wakeups, expired leases, provider failure/fallback, actual Orb preparation, authorization/service/secret mutations in isolated fixtures, and long-duration resource/cache tests. Full command mutation coverage belongs in disposable test owners/workspaces; production secret writes, sync/publication, upgrades, and service lifecycle operations were not executed in this audit.

Existing checks run: hosted interactive-session unit suite **37/37 passed**; submission-recovery, turn-submission, and pending-action TUI suites **5/5 passed**. No product code changed, so a full build/typecheck was not used as a substitute for live evidence. Extend these tests with the incident cases before implementing the fixes.
