# Testing, Evals, and Parity Evidence

## Layers

Every behavior-bearing service has a test or memory layer. Tests use deterministic time, ids, models, and tool outcomes through Effect layers.

## Test Classes

- Schema and codec tests.
- Service tests.
- SQL integration tests.
- Baton golden transcripts and tool-call assertions.
- Relay restart and replay tests.
- Effect CLI parser and output tests.
- TUI reducer and character-frame tests.
- Pixel comparison captures.
- Packaged binary smoke tests.
- Packaged CLI end-to-end tests that spawn the real built artifact and assert stdout, stderr, exit codes, signals, files, and persisted state.
- Native OpenTUI end-to-end tests that drive real keyboard input and terminal resize behavior through the packaged application.
- Real model and MCP opt-in tests.
- Kill-point tests after external side effects, Relay acceptance, projection commits, active child execution, and migration steps.
- Runtime-cardinality tests proving one Relay SQLite client, migration sequence, runner, fan-out host, Workflow host, Thread Host registry, and notification graph per process.
- Ownership tests covering two-process startup, stopped owners, `SIGKILL` release, stale diagnostics, legacy binaries, and acquisition before the first SQLite open.

## Coverage

First-party `apps/**/src` and `packages/**/src` maintain at least 95% statements, branches, functions, and lines coverage. Generated files and platform-native vendor code may be excluded explicitly; domain and adapter code may not be excluded merely because it is difficult to test.

Coverage is a floor rather than proof of behavior. E2E, durability, transcript, and eval evidence remain mandatory.

## Deterministic Agent Harness

Rika uses `@batonfx/test` and product-owned test layers to script Effect AI model responses and capture normalized requests. The harness must support:

- Streaming text and reasoning parts.
- One and many tool calls per model turn.
- Incremental tool input and malformed or schema-invalid calls.
- Successful, failed, suspended, and approval-gated tool outcomes.
- Steering and queued future Turns.
- Retryable and terminal model failures.
- Context compaction and tool-output spilling.
- Maximum-step, token, time, and cost termination.
- Child Run spawn, progress, completion, partial failure, cancellation, and join.
- Process kill and restart against the same Relay SQLite state.
- Process kill after Turn persistence, Relay acceptance, model output, canonical terminal commit, product projection, and Thread Host notification.
- Versioned dynamic workflow branches, joins, approvals, timers, retries, and compensation.

Golden transcripts assert structured requests, tool names, arguments, results, parent-child correlation, checkpoints, and exactly-once visible side effects. Long scenarios run hundreds of deterministic events without real sleeps by using Effect test time and scripted model cursors.

Packaged deterministic scenarios may set `RIKA_TEST_MODEL_SCRIPT` to a JSON array of turns. Each turn contains a non-empty `parts` array of `{ "type": "text", "text": string }`, `{ "type": "reasoning", "text": string }`, or `{ "type": "toolCall", "name": string, "params": unknown, "id"?: string }`, plus an optional non-negative integer `delayMs`. This supports multi-part responses, tool loops such as `read_file` and `edit_file`, and observable delayed streaming through the `@batonfx/test` model. Scripted fixtures keep their single fixed model selection when the TUI supplies its default reasoning effort; production model registrations continue to use exact effort and fast-mode variant keys. `RIKA_TEST_MODEL_SCRIPT` and the legacy single-text `RIKA_TEST_MODEL_RESPONSE` fixture are mutually exclusive.

Current retained evidence includes extracted-artifact Review text and JSON flows, native Relay SQLite restart of Approved, Denied, and Always permission waits with duplicate-start and cursor-replay checks, and terminal replay deduplication by stable event id and cursor. The permission matrix asserts one tool result for Approved and Always, no tool effect for Denied, and no duplicate effect after restart. This evidence does not yet prove compaction replay.

## Live Model Verification

Live tests are opt-in and route Effect AI provider registration through the owner's local Vibe proxy. Configuration is read only through the application Effect Config boundary. The suite accepts a base URL and any required secret through environment or a local ignored config file; it never embeds, logs, snapshots, or exports credentials.

Live tests cover one short turn, one coding tool call, one multi-turn tool loop, one subagent run, and one workflow smoke. They record redacted model ids, durations, token counts, tool calls, and outcomes. Live results are reported separately from deterministic CI because provider availability and model behavior are nondeterministic.

## Feature Evidence

A feature is `verified` only when its ledger row links to passing automated evidence and, where applicable, a packaged real-flow record. Code presence alone is not parity.

The visual baseline manifest records the v1 commit, dirty-worktree snapshot, OpenTUI and native package versions, Bun version, terminal profile, font, dimensions, dynamic masks, thresholds, and golden artifact locations. Performance evidence records startup, input latency, scroll-during-stream behavior, and long-thread memory budgets.
