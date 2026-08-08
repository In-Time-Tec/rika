# Plan 032: The first message never flashes back to the welcome orb

## Goal

After this work:

- sending the first message from the welcome orb transitions to the transcript exactly once and stays there — the screen never briefly returns to the welcome orb mid-submission;
- the base `ThreadViewSnapshot` for a thread created by submission already contains the user's prompt unit, so the client timeline is never rebuilt from an empty authoritative snapshot during a submission;
- the client `busy` flag stays true from Enter until the turn settles (it currently flaps false between the empty snapshot and `TurnStarted`);
- a regression test guards the server event ordering, and a controller test guards the client invariant "after submit, the welcome state never returns".

This is a server-side ordering defect. The client's optimistic entry is not at fault; it is wiped by a full-replacement snapshot that the server publishes before the first turn exists.

## Reproduction

Observed in the TUI (0.3.11): on the welcome orb screen, type a message and press Enter.

1. Welcome orb screen.
2. Press Enter → screen transitions to the blank transcript with the user prompt (the optimistic provisional entry) — correct.
3. Screen briefly returns to the welcome orb.
4. Screen transitions back to the transcript (server turn arrives) — correct end state.

Scripted reproduction against the real reducer and feed (no UI needed). Feed = `makeThreadViewFeed`, controller = `InteractiveController.update` from `apps/rika/src/interactive/controller/interactive-controller.ts`:

```
0. startup: welcome orb                                     entries=0 blocks=0 busy=false welcome=true
1. user presses Enter (provisional entry)                   entries=1 blocks=0 busy=true  welcome=false
2. server: empty SelectionLoaded snapshot                   entries=0 blocks=0 busy=false welcome=true   <-- FLASH
3. server: TurnStarted patch with prompt unit               entries=1 blocks=0 busy=true  welcome=false
```

The step-2 snapshot is published by `activateCreatedThread` (server) while the client renders `welcomeVisible` = `entries.length === 0 && blocks.length === 0` (`packages/terminal/src/opentui/surface/opentui-welcome-state.ts:3`).

## Root cause

### Server publishes an empty base snapshot before the first turn exists

`packages/product/src/operation/interactive/interactive-session-submission-stages.ts`, `submitInteractiveOperation` (≈ line 300):

```ts
if (thread === undefined) {
  thread = yield* threads.create({ id: yield* options.makeThreadId, workspace, title: temporaryThreadTitle(prompt), ... })
  yield* activateCreatedThread(thread, getCurrentSelectionEpoch(), dispatch)
}
// ... later:
const admitted = yield* admitInteractiveSubmission(input, thread, prompt, ...)
```

`activateCreatedThread` (`packages/product/src/operation/interactive/interactive-selection-projection.ts:29`) dispatches, in order:

- `ThreadActivated`
- `SelectionLoaded` with `entries: []` — **an empty selection with no `activeTurn`**

The turn is admitted only afterwards, and `TurnStarted` / `ExecutionProjectionChanged` (which carry the prompt unit) arrive later still, after `prepareExecution` in the forked execution fiber. So the thread's base snapshot is empty for the whole admission-plus-context-preparation window.

### Client rebuilds the timeline from every snapshot and treats empty as "welcome"

`apps/rika/src/interactive/controller/terminal-interactive-feed.ts` — `project()` (≈ line 40) and `updateStateImpl`:

```ts
const clearTimeline = (model: Model): Model => ({
  ...model, entries: [], blocks: [], items: [], seenEventIds: [], ...
})
```

Every `ThreadViewSnapshot` (full replacement) and every `ThreadViewPatch` (re-projection of the whole applied snapshot) starts from `clearTimeline(model)` and rebuilds **only** from the snapshot's turns. The optimistic provisional entry (created client-side by the `Submitted` reducer) lives outside the server snapshot, so the empty snapshot deletes it. The model then has `entries.length === 0 && blocks.length === 0`, and the surface renders the welcome orb. When the first patch with the prompt unit arrives, the projection rebuilds the user entry and the transcript returns.

Two second-order symptoms of the same wipe:

- `busy` is set by `project()` from `activeTurn`/turn statuses; the empty snapshot yields `busy: false` until `TurnStarted` flips it back.
- `SubmissionAdmitted`'s `reconcileUserEntry` finds nothing to bind (the provisional item is gone), so the optimistic entry is replaced by the server's prompt unit instead of being reconciled.

### The infrastructure for the right snapshot already exists

`snapshotFromSelection` in `packages/product/src/operation/interactive/interactive-thread-view-feed.ts:223`:

```ts
if (event.activeTurn !== undefined && !grouped.has(String(event.activeTurn.id))) {
  grouped.set(String(event.activeTurn.id), {
    turn: ThreadView.turnRecord(event.activeTurn),
    units: [promptUnit(event.activeTurn)],
    projectionRevision: 0,
    usage: ExecutionProjection.emptyUsageState(),
  })
}
```

A `SelectionLoaded` may carry `activeTurn`, and the base snapshot then contains the turn's prompt unit. The thread-open path already uses this (`interactive-transcript-page.ts:135,164` — `turns.findActive` → `activeTurn`). Only the created-thread path (`activateCreatedThread`) publishes `SelectionLoaded` with neither `entries` nor `activeTurn`, and it is the path taken by the first message. The feed test at `packages/product/test/interactive-thread-view-feed.test.ts:50` even publishes `SelectionLoaded` with `entries: []` + `activeTurn` — the created-thread path just never passes one.

## Why it was invisible

- No session-level test asserts the event ordering of a first submission; `packages/store/test/product-operation/*` tests submit against already-open threads or never inspect the first snapshot.
- The TUI test "echoes an idle submission in the next frame before server admission" (`apps/rika/test/app-submission.tui.test.ts:9`) holds admission, so it only sees the optimistic frame and the final completion frame — the empty snapshot is published after release and is never asserted against.
- The controller tests (`apps/rika/test/interactive-controller-thread-view.test.ts`) start from a pre-loaded snapshot; none feeds `Submitted` followed by the created-thread snapshot sequence.

## Fix

Move the created-thread activation to **after** turn admission and pass the admitted turn as `activeTurn`, so the base snapshot already contains the user prompt unit. No empty `SelectionLoaded` is ever published on the submission path, the client never rebuilds from an empty timeline during submission, and no client-side optimistic-reconciliation machinery is needed.

### Step 1 — `activateCreatedThread` accepts an optional `activeTurn`

`packages/product/src/operation/interactive/interactive-selection-projection.ts`:

- import the turn type: `import type * as Turn from "@rika/product/turn-record"` (or the value import style already used for `Thread`/`TurnRepository`).
- `activateCreatedThread(thread, epoch, dispatch, activeTurn?)` — add `activeTurn?: Turn.Turn` after `dispatch`.
- pass it through on the `SelectionLoaded` event:

```ts
dispatch({
  _tag: "SelectionLoaded",
  ...
  queue: queue.turns.map(queueItem),
  ...(activeTurn === undefined ? {} : { activeTurn }),
})
```

- mirror in the state type `packages/product/src/operation/interactive/interactive-session-state.ts:53` (`activateCreatedThread: (thread, epoch, dispatch, activeTurn?) => ...`). The two other callers (`interactive-shell-session.ts:87`, `interactive-transcript-lifecycle.ts:87`) stay three-argument and are unchanged.

### Step 2 — submit the turn before activating a created thread

`packages/product/src/operation/interactive/interactive-session-submission-stages.ts`, `submitInteractiveOperation`:

- in the `thread === undefined` branch, only create the thread and remember it was created:

```ts
let created = false
if (thread === undefined) {
  thread = yield* threads.create({ ... })
  created = true
}
```

- after `admitInteractiveSubmission` returns the turn (and before the `queued` early-return / the execution fork), when `created` is true:

```ts
if (created) yield * activateCreatedThread(thread, getCurrentSelectionEpoch(), dispatch, turn)
```

Ordering notes (verified against the code):

- The admitted turn for a created thread always has status `"accepted"` (`createForSubmission` sets `accepted` when no active turn exists — `packages/store/src/turn/turn-memory-submission.ts:33`; a created thread has no active turn). `accepted` is one of the statuses `project()` treats as active, so the base snapshot also sets `busy: true` and `activeTurnId` — no busy flap.
- `SubmissionAdmitted` now arrives before `ThreadActivated`/`SelectionLoaded`. The client handles it (`process-events.ts` applies when `currentThreadId === undefined`) and binds the provisional entry; the subsequent snapshot replaces it with the server's prompt unit in the same visual frame.
- The feed drops `TurnStarted`/`ExecutionProjectionChanged` until `current` exists (`interactive-thread-view-feed.ts`), and activation now happens synchronously between admission and the execution fork, so no event is lost.
- The queued-turn `queueMutationEvent` branch is dead for the created-thread path (`admitInteractiveSubmission` returns the turn, not a `{ queue }` envelope), and `SelectionLoaded` reads the queue after admission anyway.
- If admission fails (`QueueFull`, etc.), the thread is simply never activated; the client's existing `SubmissionRejected` path settles the provisional entry and restores the input from `submittedDrafts` — strictly better than today, where an empty thread is activated first and the provisional entry is wiped before the failure arrives.

### Step 3 — regression tests

1. **Feed level** — `packages/product/test/interactive-thread-view-feed.test.ts`: add a test that publishing `SelectionLoaded` with `entries: []` and an `activeTurn` (the created-thread shape) yields a `ThreadViewSnapshot` whose turns contain the prompt unit (`key: "turn:<id>:user"`, `content.role === "user"`, `text === turn.prompt`), and that the following `TurnStarted` produces a valid patch with `baseRevision: 0`.

2. **Session level** — new test in `packages/store/test/product-operation/` (pattern from `minimal-drain.test.ts` / `operation-queue-drain.test.ts`): open an interactive session with `holdSession` + `openInteractiveSession`, attach `session.events`, `session.submit("first message")`, settle; assert the first `ThreadViewSnapshot` received for the created thread already contains the prompt unit — i.e., no empty snapshot precedes a snapshot with the turn.

3. **Controller level** — `apps/rika/test/interactive-controller-thread-view.test.ts`: feed `Submitted` (with a non-empty input and `submissionId`) into a fresh model, then a `ThreadViewSnapshot` whose turns carry the prompt unit; assert `welcomeVisible(model)` is false after the snapshot (never true after submit) and `busy` stays true. This is the client invariant the server fix preserves.

### Step 4 — TUI acceptance (manual or `test-tui`)

Optional but recommended: extend `apps/rika/test/app-submission.tui.test.ts`'s "echoes an idle submission" test to release admission and then assert the completion frame still contains the prompt exactly once. The controller-level test is the deterministic guard; the TUI assertion guards the rendered surface.

## Explicitly not done

- No client-side change: `project()`'s wipe-and-rebuild is correct for authoritative snapshots, and welcome-on-empty is the correct state for genuinely empty threads. Preserving optimistic entries across snapshots would require duplicate-entry reconciliation against the server's prompt unit and is unnecessary once the server never publishes an empty base snapshot on the submission path.
- No change to the thread-open path (`interactive-transcript-page.ts`), which already carries `activeTurn`.

## Verification

```bash
bun --bun vitest run --project unit   packages/product/test/interactive-thread-view-feed.test.ts   packages/store/test/product-operation   apps/rika/test/interactive-controller-thread-view.test.ts
bun run check
```

The scripted reproduction (Submit → SelectionLoaded → TurnStarted) must show `welcome=false` at every step after submit. Manual acceptance: first message from the welcome orb transitions to the transcript once and never flashes back.

## STOP conditions

- The first `ThreadViewSnapshot` after a first submission contains the prompt unit.
- No `ThreadViewSnapshot` with zero turns is published between submit and `TurnStarted` on the created-thread path.
- `welcomeVisible` is false in every model state after `Submitted` until the turn settles.
- `bun run check` is green.
