# Plan 016: Transcript viewport ownership and frame stability

> **Executor instructions**: Read this plan in full before editing. Preserve the
> existing true-bottom regression test and do not combine this work with
> transcript-unit windowing, row renderer extraction, or unrelated TUI cleanup.
>
> **Drift check (run first)**:
> `git diff -- packages/tui/src/adapter.ts packages/tui/src/transcript-viewport.ts packages/tui/src/view-state.ts apps/rika/src/main.ts packages/tui/test/opentui-adapter.test.ts packages/tui/test/transcript-viewport.test.ts`
>
> **Boundary**: `repos/*` is vendored, read-only reference. Do not patch it.
> If OpenTUI cannot support a one-owner design without an upstream change, stop
> and present the minimal reproduction and options to the user.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: medium
- **Category**: bug + simplification
- **Depends on**: none
- **Issue**: —

## Evidence and problem statement

The production symptom is a flickering/blank transcript when the user wheels
past the followed transcript bottom. The deterministic OpenTUI reproduction is
in `packages/tui/test/opentui-adapter.test.ts`:

1. render an 80-entry transcript below all mounted-window limits;
2. settle at exact global bottom while `scrollFollow` is true;
3. deliver eight individual downward wheel events;
4. advance the adapter's 16 ms wheel timer and flush after every event.

Before the narrow fix, the sequence produces **eight redundant
`scrollFollow` callbacks**, each synchronously feeding a new model through
`Surface.update`, despite the viewport already being followed at its true
logical bottom. The test renderer did not emit a blank character frame for this
minimal fixture, so it establishes the causal feedback loop rather than claiming
that the headless renderer faithfully reproduces the terminal paint artifact.

The shipped narrow correction is deliberately small:

- `Surface.handleTranscriptWheel` returns before scheduling its wheel timer if
  the direction is down, the model is already following, no user detachment is
  pending, and `atTranscriptBottom()` is strict true.
- The regression asserts eight byte-for-byte stable post-flush captures, zero
  `scroll` reports, zero redundant `scrollFollow` reports, and retained
  following state.

This stops the known no-op timer → follow callback → re-render loop. It does
not solve the structural problem: scroll state, windowing, anchors, and direct
scroll writes are still distributed across `adapter.ts`, `view-state.ts`, and
`apps/rika/src/main.ts`.

## End state

Make transcript scrolling understandable through one authority table:

| Concern                                    | Authority                                      |
| ------------------------------------------ | ---------------------------------------------- |
| Followed vs detached semantic state        | `transcript-viewport.ts` pure state machine    |
| Exact physical-bottom calculation          | one live-metrics helper                        |
| Ordinary wheel movement                    | exactly one selected executor                  |
| Mounted row/item window policy             | pure viewport/window decisions                 |
| Programmatic follow and anchor restoration | one adapter post-layout actuator               |
| Model notifications                        | edge-triggered only                            |
| Scrollbar presentation                     | derived from live geometry, never an authority |

The non-negotiable invariants are:

1. Wheel-down at the followed true global bottom is a semantic no-op.
2. A wheel event has at most one physical-scroll writer.
3. `Following → Following` never emits a viewport-driven model notification or redundant reconciliation.
4. Detached content changes restore a stable row/unit anchor, not an absolute
   historical `scrollTop`.
5. Programmatic positioning occurs only after layout and is clamped against
   live `scrollHeight - viewportHeight`.
6. Physical, mounted-window, and logical bottom are distinct predicates.
7. Every regression scenario asserts intermediate rendered frames, not only its
   eventual state.

## Implementation phases

### 1. Lock down the regression matrix

Keep the existing true-bottom test as the smallest causal regression. Extend it
without weakening its callback-count assertions:

- capture and compare the transcript after every individual wheel event/timer flush;
- assert a bottom sentinel is retained in every capture;
- assert `scrollTop === maxScrollTop` after every flush;
- subscribe to `CliRenderEvents.FRAME` for scenarios that may render more than
  once during a flush, and assert each emitted transcript frame is non-blank;
- preserve the test below entry/row window limits so it cannot accidentally test
  paging instead of true-bottom behavior.

Add deterministic frame-sequence integration coverage for:

- detached user returns to true bottom and re-follows exactly once;
- physical/mounted bottom with newer logical items advances a window;
- physical/mounted/logical bottom does not advance one;
- a down-wheel reaches true bottom while an earlier wheel timer remains pending;
- streaming at followed bottom;
- streaming while detached with a stable visible sentinel;
- collapse/reflow and terminal height change while detached.

For each scenario, collect diagnostics on failure: frame index, wheel direction,
raw/live scroll metrics, follow state, item/row window bounds, pending-anchor
state, and mounted transcript record keys.

**Verification**

```sh
bun --bun vitest run --project unit packages/tui/test/opentui-adapter.test.ts
bun --bun vitest run --project unit packages/tui/test/transcript-viewport.test.ts
```

### 2. Choose and prove the wheel owner

Make a throwaway characterization against the pinned OpenTUI version. The
existing architecture audit indicates a renderable mouse listener cannot reliably
prevent OpenTUI's default mouse path, so the expected choice is:

- OpenTUI executes ordinary physical wheel movement;
- Rika observes settled geometry and selects semantic policy;
- Rika only performs a programmatic position for a real anchor, content growth,
  direct navigation, or a needed logical-window transition.

Prove the choice with instrumentation that records every `scrollTop` write and
its reason. A single wheel event must record one user-motion writer or none at a
true bottom—not both a native write and an adapter write.

**Stop condition**: if neither ownership model yields at most one writer without
editing `repos/*`, stop and report the minimal upstream reproduction.

### 3. Make `transcript-viewport.ts` authoritative

Extend the existing module rather than creating another state abstraction. Keep
it pure and free of OpenTUI imports.

Introduce explicit input events and pure outputs, for example:

```ts
type ViewportEvent =
  | { readonly _tag: "WheelObserved"; readonly direction: "up" | "down"; readonly delta: number }
  | { readonly _tag: "GeometrySettled"; readonly metrics: ViewportMetrics }
  | { readonly _tag: "ContentChanged" }
  | { readonly _tag: "Resized" }
  | { readonly _tag: "FollowRequested" }
  | { readonly _tag: "WindowBoundaryReached"; readonly direction: "older" | "newer" }

type ViewportDecision = {
  readonly state: ViewportState
  readonly window: ViewportWindow
  readonly target:
    | { readonly _tag: "None" }
    | { readonly _tag: "Bottom" }
    | { readonly _tag: "Anchor"; readonly anchor: ViewportAnchor }
  readonly notification: { readonly _tag: "None" } | { readonly _tag: "Detached" } | { readonly _tag: "Followed" }
}
```

The adapter converts UI facts to events and executes decisions; it must not
invent independent follow/window/anchor state.

Add pure tests for all invariants, especially:

```text
Following + WheelDown + exact global bottom
=> identical state, target None, notification None
```

### 4. Add one post-layout viewport actuator

Add one adapter operation—named for its responsibility, such as
`applyTranscriptViewport`—which is the only Rika-owned programmatic position
writer. Its ordering is fixed:

```text
reconcile transcript
→ complete layout
→ read live geometry
→ resolve bottom or stable anchor
→ clamp once
→ set scroll position once
→ synchronize scrollbar
→ request a repaint only if the content or position changed
```

Migrate each existing direct assignment/call to `transcriptScroll.scrollTop`,
`scrollTo`, `scrollBy`, and sticky-follow-related correction into this actuator,
or explicitly identify it as the chosen native wheel executor. Do not leave
silent exceptions.

Use a generation token for deferred anchor work so stale frame/timer callbacks
cannot overwrite a newer viewport decision.

### 5. Remove duplicated authority incrementally

Migrate one field family per commit, retaining full regression coverage after
each step:

1. redundant bottom/follow reports and model callbacks;
2. `userScrollDetached` and follow state;
3. wheel timers and accumulated adapter deltas;
4. pending anchor state and direct absolute-offset restoration;
5. item/row mounted-window state;
6. model-level `scrollOffset` feedback if it is no longer authoritative.

Make notifications edge-triggered: report `Followed` only when transitioning
from detached to followed; report detach only on the reverse transition.

Keep strict bottom separate from a visual near-bottom tolerance. Near-bottom can
inform paging/UX but must not silently force follow state.

### 6. Resolve sticky scroll and culling after ownership is stable

Do not leave both OpenTUI sticky scroll and Rika explicit follow writing active.
Once Phase 2 establishes the selected wheel owner, disable the losing mechanism.
If Rika owns follow positioning, set `stickyScroll: false` permanently.

If frame diagnostics show valid mounted records/ranges but blank terminal cells,
run the same regression with `viewportCulling: false` while retaining Rika's
bounded entry/row windows:

- if that fixes the blank frame, ship culling disabled for this transcript as a
  correctness-first mitigation;
- file or update a minimal OpenTUI upstream reproduction;
- measure rendering cost before considering a replacement culling policy.

### 7. Document the seam for future agents

Add a short developer document near the viewport module, or module-level
architecture comments, containing:

- the authority table above;
- the three bottom definitions;
- allowed scroll writers and their phase;
- the anchor representation and generation rule;
- the frame-level test matrix and focused test command.

Keep `Surface.update` ordered into explicit passes—transcript reconcile,
viewport decision/apply, composer/queue, overlays—only after ownership is in
place. Do not mix behavior-neutral renderer extraction with this bug fix.

## Completion criteria

- All direct programmatic transcript position writes pass through one actuator.
- Each wheel input has one physical owner.
- True-bottom down-wheel creates no model notification, timer, redundant
  reconciliation, window shift, or Rika-owned programmatic position write.
- Frame-level integration coverage remains stable for all scenarios in Phase 1.
- Culling is either shown stable by the matrix or disabled with performance data
  and an upstream reproduction.
- `bun run check` passes.
