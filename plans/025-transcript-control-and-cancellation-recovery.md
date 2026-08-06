# Plan 025: Preserve compacted history and make execution control non-destructive

## Goal

After this work:

- context compaction leaves the complete durable Thread history available and adds one visible compaction row to the affected root Turn;
- steering at any point after the TUI exposes an active Turn is either accepted exactly once or rejected as a non-terminal control failure without breaking the running agent;
- cancelling a Turn ends it as `cancelled`, marks open tool and Child Run rows with cancellation icons, and emits no red execution-failure UI or interrupt-only error logs;
- Relay's internal wait cancellation does not produce a visible `! wait cancelled` notice; and
- genuine execution failures, explicit cancellation reasons, and failed control requests remain visible and recoverable.

This plan changes execution control and transcript projection. It does not change queue semantics, compaction policy, prompt construction, Child Run ownership, or Relay's authority over execution and cancellation.

## Evidence and current path

### Durable history is retained but the initial projection can hide its compaction boundary

- `docs/features/context-compaction.md` says compaction preserves the current prompt and durable transcript.
- `packages/transcript/src/index.ts` revises one stable `compaction:<turnId>` unit rather than replacing prior units.
- `packages/persistence/src/transcript-repository.ts` upserts projection units during `appendAll`; only the explicit full-rebuild `replace` path deletes and rewrites a Turn's disposable projection.
- `packages/app/src/operation.ts` now builds an initial transcript window by Turn and reduces oversized Turns through `isSemanticTranscriptEntry` and `boundTurnEntries`. Root entries and execution outcomes are semantic, but the root `Compaction` block is not. It can therefore disappear from the initial page even though Relay and SQLite still retain it.
- The current tests prove reducer compaction and generic pagination separately. They do not prove that a compacted oversized Turn reopens with prior conversation plus one visible compaction row and can page back to every retained key.

### The TUI exposes steering before Relay is guaranteed to accept it

- `packages/app/src/operation.ts` sets a Turn to `running` and emits `TurnStarted` before calling `rootTurnOwner.start`.
- `packages/tui/src/view-state.ts` enables Ctrl+S whenever the model is busy and has composer text.
- `packages/runtime/src/execution-backend.ts` sends `client.executions.steer` immediately. Its cancellation path already waits for the deterministic Relay execution to become available.
- `packages/app/src/operation.ts` routes a rejected `steer` through generic `safe`, which emits `ExecutionFailed`.
- `packages/tui/src/view-state.ts` treats `ExecutionFailed` as terminal: it clears `busy`, activity, and `activeTurnId`, even if Relay's agent continues running.

### Expected cancellation still crosses generic failure boundaries

- Relay owns root cancellation, descendant cancellation, waits, and terminal state.
- `packages/app/src/operation.ts` requests durable stop, calls root cancellation, then explicitly cancels each previously discovered child. With current Relay cancellation cascade, that second control loop can race already-terminal children and log false failures.
- `packages/app/src/root-turn-owner.ts` logs every caught cause as `root-turn-owner.run.failed`, including interrupt-only causes from expected scope shutdown.
- Interactive submit/observer wrappers in `packages/app/src/operation.ts` also log generic causes and can dispatch failure from command effects without separating control rejection from execution terminal failure.
- Successful `ExecutionControlled { action: "cancelled" }` already maps to `ExecutionCancelled`; the TUI reducer already changes open tool and Child Run blocks to `cancelled`. The intended presentation exists, but failure classification can bypass it.

### `! wait cancelled` is terminal-reason leakage, not a `wait.cancelled` projection

- `wait.cancelled` is an observable Relay event but currently creates no transcript unit.
- After response evidence, `execution.cancelled` projects its reason as a notice entry.
- `packages/tui/src/adapter.ts` renders any cancellation notice other than the exact text `cancelled` as `! <reason>`.
- In the pinned Relay contract, an internally cancelled wait can become the unstructured terminal reason `wait cancelled`. Rika cannot safely distinguish that generated reason from an explicit reason by matching text.

## Target design

Keep two related fixes under one acceptance plan, but do not force compaction into the control state machine.

```diagram
┌───────────────┐  steer/cancel  ┌──────────────────┐  durable control  ┌─────────┐
│ TUI optimistic│───────────────▶│ Rika operation   │──────────────────▶│ Relay   │
│ control state │                │ control boundary │                   │ runtime │
└───────┬───────┘                └────────┬─────────┘                   └────┬────┘
        │                                 │                                  │
        │ accepted                        │ rejected, non-terminal           │ events/result
        ▼                                 ▼                                  ▼
┌───────────────┐                ┌──────────────────┐              ┌──────────────────┐
│ pending steer │                │ control failure  │              │ transcript       │
│ or cancelled │                │ restore/retry UI │              │ projection       │
└───────────────┘                └──────────────────┘              └──────────────────┘
```

### Control outcomes

Represent three different facts instead of overloading `ExecutionFailed`:

1. **Execution terminal:** `completed`, `failed`, or `cancelled`, derived only from authoritative Turn/Relay state.
2. **Control accepted:** existing `ExecutionControlled` actions such as `steered` and `cancelled`.
3. **Control failed:** a new typed interactive event, provisionally `ExecutionControlFailed`, carrying the action, safe message, and available Thread/Turn identity. For steering it must carry enough identity to remove the rejected optimistic row and restore the submitted text.

`ExecutionControlFailed` is non-terminal. Its TUI handling must preserve `busy`, `activeTurnId`, and the running transcript. A failed steer restores its text when the composer is empty. A failed cancel clears `cancelPending` so the user can retry. Genuine `ExecutionFailed` keeps its current red terminal behavior.

### Steering readiness

`@rika/runtime` owns translation from Rika's deterministic execution identity to Relay's steer request. Before sending the single idempotent request, it should wait interruptibly for that exact execution to reach Relay's steerable state.

- Missing, accepted, or queued state: poll with the repository's existing bounded retry style.
- Running state: call steer once with the original idempotency identity.
- Terminal state: return a typed control rejection; never retarget later work.
- Waiting/approval state: verify the released Relay/Baton contract before deciding whether it is steerable. Do not infer this from local status names.
- Timeout or transport failure: return a typed control failure and preserve optimistic text for retry.

Do not move `TurnStarted` as a substitute for readiness. It is a Rika product transition, not proof that Relay has accepted the execution.

### Cancellation ownership

Use one root cancellation request. Relay remains responsible for interrupting and joining the execution tree and cancelling waits and descendants. Rika may inspect descendant IDs before cancellation so it can replay/backfill their terminal events immediately, but it must not issue a second competing cancel to each child unless the released Relay contract proves root cascade is absent.

Expected interrupt-only causes at local observer/owner scope boundaries must terminate quietly. They must not mutate the durable Turn to `failed` or emit error-level diagnostics. Non-interrupt defects continue to log and surface.

Rika marks a Turn cancelled only from:

- successful pre-start cancellation;
- an authoritative backend result/status of `cancelled`; or
- an `execution.cancelled` event.

Local fiber interruption alone is not cancellation evidence because a client or observer may stop while Relay continues durably.

### Cancellation reason provenance

Do not blacklist `wait cancelled` in the TUI or transcript projector. First verify the pinned Relay event/result shape. If it does not distinguish internal generated wait reasons from explicit caller/runtime reasons, stop this slice and fix or upgrade Relay so one of these is true:

- terminal cancellation carries structured reason provenance such as `wait`, `caller`, or `runtime`; or
- Relay omits its generated wait fallback from `execution.cancelled` while retaining explicit reasons.

With structured provenance, the transcript projector suppresses only internal wait-generated text. It still records the cancelled execution outcome and settles open tools/Child Runs. Explicit cancellation reasons continue to produce one notice.

### Compaction projection

Treat root compaction as semantic transcript context for bounded initial pages. Handle known lifecycle events explicitly:

- `agent.compaction.started` revises the stable unit to `running`;
- the released committed/completed event revises that same unit to `complete` with its checkpoint;
- a compaction failure must not be classified as complete; it remains a typed failure or retry notification according to the released Baton event contract.

The full rebuild path may call projection `replace` only after complete forward replay from Relay has succeeded. A partial replay must leave the previous disposable projection intact and surface repair failure.

## Decisions

- Fix steering readiness in the runtime adapter, where Relay's state and contract are visible. Do not add delays in the TUI.
- Add a distinct control-failure event. A side-command rejection is not an execution terminal.
- Keep cancellation presentation driven by typed statuses and outcomes. Do not hide arbitrary strings or red rows in the renderer.
- Let Relay perform root-to-descendant cancellation once. Rika projects the result; it does not compete for execution ownership.
- Keep compaction history work separate in code, but verify it in the same user-level acceptance scenario because compaction, steering, and cancellation all occur during long-running Threads.
- Keep one compaction row per root Turn, matching the current stable unit key. Do not invent a Thread-global compaction owner.
- No stored-data migration is required. Rika's transcript table is a rebuildable projection; Relay remains authoritative.

## Implementation slices

### 1. Prove the released Relay/Baton contracts before changing Rika

- **Result:** The implementation has verified steerable states, cancellation cascade/cleanup, compaction lifecycle event names, replay completeness after compaction, and cancellation reason provenance.
- **Changes:** Inspect the pinned package exports and source only. Record any required upstream package version in this plan or the implementation PR. Do not edit `repos/*`.
- **Tests:** Add a focused runtime contract test only if the released behavior is available but currently unpinned locally: early steer readiness, root cancellation cascade, complete replay across compaction, and internal wait cancellation provenance.
- **Checks:** Run the narrow `packages/runtime` tests selected by the new contract cases.
- **Depends on:** None.
- **Stop conditions:** Stop the affected slice if Relay loses pre-running steering, root cancel does not await/cascade, replay omits pre-compaction events, or cancellation provenance is unstructured. Fix/release upstream rather than emulate ownership in Rika.

### 2. Separate control rejection from execution failure

- **Result:** Failed steer/cancel requests are visible and recoverable without clearing the active execution.
- **Changes:** Extend `packages/app/src/operation-contract.ts` with a typed control-failure event. Route steer and cancel command failures through it in `packages/app/src/operation.ts`. Map it in `apps/rika/src/main.ts`. Add a matching `packages/tui/src/view-state.ts` message that restores optimistic steering text or clears `cancelPending` while preserving active execution state.
- **Tests:** In `packages/app/test/operation.test.ts`, prove backend steer failure and repository/cancel failure emit control failure, not `ExecutionFailed`. In `packages/tui/test/view-state.test.ts`, prove active state survives, failed optimistic steering is removed/restored, and cancel can be retried. Preserve a test that real execution failure still clears the active state and renders red.
- **Checks:** Run the focused app operation and TUI reducer tests.
- **Depends on:** Slice 1's control contract.
- **Cleanup:** Remove control-command use of generic `dispatchFailure` where it can emit terminal `ExecutionFailed`.

### 3. Close the early-steering race at the runtime boundary

- **Result:** Ctrl+S immediately after `TurnStarted` is accepted exactly once when the same Relay execution becomes steerable.
- **Changes:** In `packages/runtime/src/execution-backend.ts`, add the bounded, interruptible availability/state gate to `steer`, preserving the supplied idempotency identity and targeting only the deterministic execution ID. Map terminal-before-steer and timeout to typed backend errors that the app classifies as control failures.
- **Tests:** Extend `packages/runtime/test/execution-backend-relay.test.ts` for missing/queued-to-running transition, exactly-once delivery, stable idempotency receipt, terminal-before-steer, timeout, and interruption. Extend `packages/app/test/operation.test.ts` for the `TurnStarted` race. Add or update `apps/rika/test/app.tui.test.ts` so immediate Ctrl+S reaches the scripted model and the agent completes without an error row.
- **Checks:** Run the focused runtime, app, and `test-tui` cases.
- **Depends on:** Slices 1 and 2.
- **Cleanup:** Remove any test timing workaround that waits for model activity solely to make steering safe.

### 4. Normalize expected cancellation at owner and observer boundaries

- **Result:** Ctrl+C produces one authoritative cancelled outcome, cancelled row icons, and no interrupt-only red diagnostics.
- **Changes:** In `packages/app/src/operation.ts`, use root cancellation once and replay/backfill descendant terminal events after it settles. Remove the broad child cancel fan-out if Slice 1 confirms Relay cascade. Narrow `active()` handling so an absent active Turn is a no-op but repository failure becomes control failure. At interactive submit/observer boundaries and in `packages/app/src/root-turn-owner.ts`, preserve interrupt-only causes without error logging or failed Turn mutation; keep non-interrupt failures observable.
- **Tests:** Prove cancellation of a running root with an open tool, Child Run, and `await_child_group` wait settles every visible row as cancelled; emits no `ExecutionFailed`; performs one root cancel; and produces no `turn.failed`, `interactive.submit.failed`, or `root-turn-owner.run.failed` record for interrupt-only shutdown. Prove a genuine backend or owner defect still logs/surfaces. Prove failed cancel leaves the Turn running.
- **Checks:** Run focused app owner/operation tests and the real in-process TUI cancellation case.
- **Depends on:** Slices 1 and 2.
- **Cleanup:** Delete redundant per-child cancellation code and any tests that require duplicate cancel calls.

### 5. Suppress only internal wait cancellation text

- **Result:** Cancelling while `await_child_group` is waiting shows cancellation icons but no `! wait cancelled`; explicit cancellation reasons remain visible.
- **Changes:** After the upstream contract from Slice 1 exposes provenance, carry it through `packages/runtime/src/execution-backend.ts` source events as needed and handle it explicitly in `packages/transcript/src/index.ts`. Keep `wait.cancelled` non-rendering. Set execution outcomes and block statuses regardless of notice suppression. Leave `packages/tui/src/adapter.ts` generic notice rendering unchanged.
- **Tests:** In `packages/transcript/test/projection.test.ts`, prove internal wait cancellation creates no notice, explicit caller cancellation creates exactly one notice, no-reason cancellation creates no fabricated text, and all cases settle running rows. In `packages/tui/test/tool-presentation.test.ts` or the existing cancellation visual fixture, prove no `wait cancelled` text and correct cancelled icons. Cover the complete path in `apps/rika/test/app.tui.test.ts`.
- **Checks:** Run focused transcript/TUI tests and the cancellation TUI app case.
- **Depends on:** Slices 1 and 4. Blocked if provenance is unavailable.
- **Cleanup:** No text blacklist or adapter special case may remain.

### 6. Keep compacted history and its boundary visible

- **Result:** A compacted oversized Turn reopens with prior conversation and exactly one compaction row; all omitted detail remains reachable through older-page loading.
- **Changes:** In `packages/app/src/operation.ts`, include the root `Compaction` block in semantic initial-window entries. In `packages/transcript/src/index.ts`, replace broad `includes("compact")` classification with explicit released lifecycle events. Guard `rebuildExecutionProjection` so `TranscriptRepository.replace` happens only after complete authoritative replay.
- **Tests:**
  - Reducer: pre-compaction user, assistant, tool, and child units remain after started/committed events; one stable compaction unit is revised in place; failure is not shown as complete.
  - SQLite: append, close/reopen, and page a compacted Turn; every pre-compaction key remains exactly once.
  - App paging: an oversized compacted Turn's initial page contains the user/assistant conversation boundary and compaction row; repeated `loadOlder` recovers every durable key without duplicates.
  - Rebuild failure: incomplete/cursor-stalled replay does not replace the last valid projection.
  - TUI app: force scripted compaction, verify history remains on screen with one compaction event, then continue the same Turn successfully.
- **Checks:** Run focused transcript, persistence, interactive-session, and TUI app tests.
- **Depends on:** Slice 1's compaction/replay verification.
- **Cleanup:** Remove broad compaction event matching and any fixture assumptions that compaction may erase prior units.

### 7. Verify the combined user journey

- **Result:** One long-running Thread can compact, receive steering, spawn/wait for a Child Run, and be cancelled without losing history or presenting cancellation as failure.
- **Changes:** Extend one existing `apps/rika/test/app.tui.test.ts` app instance rather than creating a separate process test. Update `docs/features/context-compaction.md` and `docs/features/execution-control.md` only if the implemented contract adds user-visible distinctions not already stated.
- **Tests:** Script: prior conversation → compaction → immediate steer → Child Run and wait → cancel. Assert prior text and one compaction row remain, steering is consumed once, open rows show cancelled icons, no red error block appears, and `wait cancelled` is absent. Reopen the Thread and repeat the transcript assertions.
- **Checks:** Run the focused TUI test, then `bun run check`. Run `bun run test-tui` if the focused runner does not cover the complete app suite. Manual Pilotty acceptance is useful but not a substitute for the in-process test.
- **Depends on:** Slices 2–6.
- **Cleanup:** Remove temporary diagnostics and timing controls used to reproduce races.

## Rollout and recovery

- Land any required Baton/Relay release before the Rika changes that consume its structured contract. Do not support mixed local package shapes with a compatibility adapter in this pre-1.0 repository.
- This work changes no authoritative stored data. Rollback can revert Rika code; Relay's durable history remains available and Rika can rebuild its projection.
- Stop release if a compacted replay has fewer pre-compaction event keys, a steer is accepted without later `steering.delivered`, cancellation produces `ExecutionFailed`, or a genuine execution/control failure becomes silent.
- Keep error diagnostics for real non-interrupt failures. The success signal is the absence of interrupt-only error records, not the absence of all cancellation telemetry.

## Completion criteria

- Compaction retains and reopens complete durable history with one visible compaction row.
- Immediate steering is delivered exactly once or fails as a non-terminal control action.
- Cancellation uses one root authority path, settles tools and Child Runs as cancelled, and emits no red failure UI/logging for expected interruption.
- Internal wait cancellation text is absent without string matching; explicit reasons remain visible.
- Focused suites and `bun run check` pass, and any unrun `test-tui` or manual acceptance work is reported explicitly.
