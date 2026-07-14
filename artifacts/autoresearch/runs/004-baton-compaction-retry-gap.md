# Run 004: Baton Compaction Summary Skips Model Resilience

Date: 2026-07-14

Status: reproduced against Rika's released dependency path; clean Baton reduction and Oracle review pending

Owner candidate: Baton compaction and model-resilience composition

## Workload

- Rika revision: `a67703464bca934f51037f2978d74c8631b2c67c`
- Published dependencies: `@batonfx/core@0.4.3`, `@relayfx/sdk@0.2.15`
- Public Rika execution backend over Relay embedded SQLite
- Baton's deterministic TestModel
- One tool call that forces automatic compaction
- The first compaction summary `generateText` call fails with a typed transient `AiError.RateLimitError`
- A successful summary and terminal model response remain scripted after the transient failure

Reduction: `/tmp/rika-compaction-summary-retry-repro.ts`

Evidence: `raw/004-baton-compaction-retry-repro.txt`

## Result

| Signal | Expected | Actual |
| --- | --- | --- |
| Execution | retries transient summary failure, then continues | failed |
| Model requests | `streamText`, failed `generateText`, retried `generateText`, final `streamText` | `streamText`, one `generateText` |
| Request count | 4 | 2 |
| Terminal event | completed after recovered compaction | `execution.failed` |

## Boundary

Baton's ordinary and structured agent model operations are wrapped through `ModelResilience`. The default compaction strategy calls `LanguageModel.generateText` directly in `packages/core/src/compaction.ts`, so a transient provider failure during summary generation bypasses the configured retry classification and finite retry schedule.

Current Baton `main` contains the same direct call. Targeted issue search found no matching existing issue.

## User impact

A long Rika session becomes more likely to compact as context grows. A single transient rate limit, timeout, or retryable provider failure at that boundary terminates otherwise recoverable work, even though ordinary model turns use the same configured resilience policy. This turns long-session context maintenance into a less reliable path than the model work it protects.

## Required design review

Before implementation, independently decide:

- whether `Compaction` should require or optionally consume `ModelResilience`;
- whether the agent loop should provide a resilience-wrapped `LanguageModel` to compaction instead of coupling compaction to the service;
- how retry classification, finite schedule, cancellation, tracing, and typed `CompactionError` causes remain visible;
- whether retry applies only to idempotent summary generation and never repeats session mutation;
- tests for transient recovery, terminal failure, absent resilience, interruption, and request counts;
- Baton release, Relay dependency update if required, Rika repin, and exact workload replay.
