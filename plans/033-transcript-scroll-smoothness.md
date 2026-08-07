# Plan 033: Transcript scroll-back must be instant, not paged

> **Status**: PROPOSED (research-backed; not yet dispatched)
> **Priority**: P1 · **Effort**: L · **Risk**: MED · **Category**: direction + performance + UX
> **Depends on**: none
> **Related docs**: `docs/features/transcript-paging.md`, `docs/decisions/bounded-transcript-projection.md`, `docs/features/transcript-navigation.md`
>
> **Executor note**: this plan is written for review first. It changes the
> bounded-transcript-projection decision (`docs/decisions/bounded-transcript-projection.md`)
> and the wire `ThreadView` contract (`packages/product/src/thread/model/*`).
> Breaking changes are welcome in this repo; do not preserve the old bounds.

## Why this matters

Wheel-scroll up in the Rika TUI is pagination, not scrolling: the user scrolls a
couple of screens, the UI freezes for roughly a second, a page of older rows
appears, and only then can they keep scrolling. Scroll-back is the primary way
a developer re-reads what an agent did; a stall-and-jump cadence makes the
transcript feel like a paged API, not a document.

## Evidence — current behavior (measured and traced)

### The TUI only ever holds ~120 units in memory

- The server's interactive view is a bounded projection:
  `packages/product/src/thread/model/thread-view-limits.ts`
  `limits = { turns: 6, timelineItems: 120, pending: 64, patchItems: 120, turnChanges: 6 }`.
- `ThreadViewSnapshot` is schema-capped at 120 timeline units
  (`thread-view-snapshot.ts` filter `timeline exceeds 120 items`;
  `thread-view-turn-usage.ts` `isMaxLength(limits.timelineItems)`).
- The initial window is 6 turns / 120 entries
  (`interactive-session-constants.ts`, `operation/interactive/transcript-window.ts`).
- Page size for `LoadOlder`/`LoadNewer` is 50 entries
  (`interactive-transcript-page.ts:93`, `interactive-session-interface-selection.ts:94`).

### Scrolling up = blocking server round trip, repeated

- `apps/rika/src/interactive/process/interactive-process-input.ts` `scroll` handler:
  `if (offset <= 0 && !loop.loadingOlder) { ... session.loadOlder(...) }` — while a page
  is in flight, **every further scroll event is discarded**.
- Each page load walks the whole chain: SQLite keyset page (50 entries) → server feed
  merge → **re-bound to 120 units with `boundedTurns(combined, "oldest")`**
  (`interactive-thread-view-feed.ts:528`) → full `ThreadViewPatch` replace → client
  `project()` wipes the model (`clearTimeline` in `terminal-interactive-feed.ts`) and
  rebuilds it → full transcript render.
- Re-bounding to 120 on prepend **evicts the newest units** (`hasNewer`), so scrolling
  back then scrolling down pages _forward_ again through the same wall — the exact
  pagination the user hates.

### Rendering rebuilds the whole bounded window per change

- Every `Surface.update` with changed transcript input rebuilds a fresh bounded model
  (`boundedTranscriptModel`, up to 600 units) — a new `items` array identity, which
  invalidates the `transcriptUnits` WeakMap cache — then rebuilds/iterates all units,
  reconciles every descriptor, lays out up to `maxMountedTranscriptRows = 3360` rows.
- Window shifts are coarse: `shiftTranscriptWindow(-100)` re-runs the full rebuild per
  100-unit step (`opentui-transcript-scroll.ts:133-142`).

### Measured numbers (local run of `bun apps/rika/src/performance-main.ts`)

| Metric                                 | Current         | Target    |
| -------------------------------------- | --------------- | --------- |
| `tui.initial-render` (5005-item model) | **687 ms**      | ≤ 150 ms  |
| `tui.stream-update.p95`                | **71 ms**       | ≤ 25 ms   |
| `tui.stream-update.p99`                | **116 ms**      | ≤ 16 ms   |
| `tui.scroll.p95`                       | 5.5 ms (passes) | ≤ 12 ms   |
| `tui.render.p95`                       | 8.1 ms (passes) | ≤ 16.7 ms |
| mounted rows                           | 899             | ≤ 6720    |

687 ms per full rebuild is the "wait a second" the user feels on every page.

## What the reference frameworks do (deep research, source-level)

Three leading terminal coding agents were researched by cloning/recovering their
source (reports in `/tmp/research-{opencode,pi,amp}.md`).

| Aspect                   | OpenCode (sst/opencode, @opentui 0.4.5)                     | Pi (earendil-works/pi)                                                                               | Amp (sourcegraph/amp, npm build 923ae4)                                               |
| ------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| History in client memory | last 100 messages, one-shot fetch; **no load-older in TUI** | **entire JSONL session loaded into memory**                                                          | **entire thread loaded into memory, unbounded**                                       |
| Fetch on scroll          | never                                                       | never                                                                                                | never                                                                                 |
| Virtualization           | OpenTUI scrollbox `viewportCulling` (±10 rows)              | none — all rows computed, only visible painted                                                       | real `ListView` virtualization, `cacheExtent = 8` rows, Fenwick extent index          |
| Terminal writes          | OpenTUI buffer diff                                         | per-row diff, batched in one sync write                                                              | double-buffered cell diff                                                             |
| Frame pacing             | 16 ms batched SSE flush, fine-grained component renders     | 16 ms render coalescing                                                                              | 60 fps coalesced frames, dirty-driven                                                 |
| Long sessions            | drop older in TUI; server compaction; truncated tool output | compaction; tool-output truncation                                                                   | compaction (`thread_truncated`); truncation; bottom lists mount-all only < 4000 items |
| Keys                     | PgUp/PgDn, line/half-page, `scrollTo` top/bottom, wheel     | PgUp/PgDn, half-page, Home/End, **prompt-marker jumps** (Ctrl+Shift+↑/↓), wheel, draggable scrollbar | ↑/↓, j/k, PgUp/PgDn, Ctrl+u/d, Home/End, gg/G, wheel, follow-mode                     |

**The invariant all three share: scrolling never performs I/O.** History is fully in
memory (Pi, Amp) or a fixed window with no fetch (OpenCode). Content is bounded by
compaction and tool-output truncation, never by navigation. All three diff terminal
writes and coalesce frames at 16 ms.

Rika is the outlier: a separate TUI process (so it must transport data), but the
transport is local (loopback WebSocket + local SQLite), so the same invariant is
achievable — hold the whole thread in the TUI process and virtualize rendering.

## Target UX

1. Scrolling up is instant from the bottom of a thread to its top — no loading, no
   blocked input, no jumps — for every thread that fits the payload bound.
2. Rendering stays smooth (≤ 16 ms frames) regardless of transcript size via
   visible-range mounting with stable per-unit caches.
3. Follow semantics are unchanged: wheel-up detaches, End/bottom re-follows.
4. For pathological threads beyond the memory cap, the TUI simply stops at the
   oldest loaded unit (like OpenCode, but with a cap ~60× larger). Nothing is
   deleted from the server's durable storage; the TUI just doesn't hold it.

## Implementation

### Phase 1 — Server: deliver the full thread; stop re-bounding

Files: `packages/product/src/thread/model/thread-view-limits.ts`,
`thread-view-snapshot.ts`, `thread-view-turn-usage.ts`,
`packages/product/src/operation/interactive/interactive-thread-view-feed.ts`,
`interactive-transcript-page.ts`, `transcript-window.ts`,
`packages/product/src/operation/interactive/interactive-session-constants.ts`.

1. Replace the unit-count bounds with a **large bounded full timeline**: the
   initial `SelectionLoaded` snapshot carries the newest `transcriptMemoryCap`
   units (proposed: 20,000 — see Risks for the memory math) up to a raised
   payload bound (proposed: 32 MiB for the initial snapshot; whichever binds
   first). Remove/raise the `turns: 6` and `timelineItems: 120` schema caps; the
   snapshot filter enforces the payload bound instead.
2. `interactive-thread-view-feed.ts`: delete the `boundedTurns(...)` re-bounds in
   both the `SelectionLoaded` path (line ~232) and the page-merge path (line ~528).
   Prepends append; `hasOlder` reflects durable truth only. Keep `limits.patchItems`
   (120) as the per-patch upsert/remove array cap — patches stay incremental.
3. `interactive-transcript-page.ts`: initial window = newest units up to
   `transcriptMemoryCap` / payload bound (reuse `boundTranscriptEntries`).
   **Delete the TUI's `LoadOlder`/`LoadNewer` path**: the commands, the
   `TranscriptPagePrepended`/`TranscriptPageAppended` events, the feed merge
   branches, and the client call sites (`interactive-process-input.ts`,
   `server-client-session.ts`, `server-client-reconnect.ts`). Nothing else
   consumes them (verified by grep). Keep `TranscriptRepository.page` only if
   the planned diagnostics view (plan 007) needs it.
4. Update `docs/features/transcript-paging.md` (paging is replaced by a one-shot
   bounded full load) and overturn `docs/decisions/bounded-transcript-projection.md`
   (the bounded-window rationale is superseded by virtualization; the memory cap
   and payload bound keep the process safe).

### Phase 2 — Client loop: one big in-memory window; scroll never hits the server

Files: `apps/rika/src/interactive/process/interactive-process-input.ts`,
`interactive/controller/terminal-interactive-feed.ts`,
`interactive/controller/interactive-controller.ts`.

1. Snapshots project the loaded thread once at open (existing `project()` path,
   now with up to `transcriptMemoryCap` units).
2. **Delete the `loadingOlder` gate and the `scroll`-handler `loadOlder` call
   entirely.** Scroll input only ever moves a local scroll position — there is no
   server call on the scroll path, period.
3. Ring-buffer eviction: when live content streams past `transcriptMemoryCap`
   units, drop the oldest units from the client model (and their mounted
   renderables) so the live tail is always present and memory stays bounded.
   The scroll range naturally tops out at the oldest loaded unit; scrolling
   further up just clamps (the anchor machinery already clamps against live
   metrics).
4. Keep `scrollFollow`/detach/End semantics untouched (`ScrollMoved`/
   `ScrollFollowed` reducers unchanged).

### Phase 3 — Client renderer: visible-range mounting (real virtualization)

Files: `packages/terminal/src/opentui/surface/opentui-surface-transcript-mount.ts`,
`opentui-transcript-scroll.ts`, `opentui-surface-lifecycle.ts`,
`rendering/opentui-render-transcript-window.ts`, `opentui-transcript-rendering.ts`,
`presentation/transcript/transcript-row.ts`.

Replace the "rebuild bounded model (≤600 units) on every change" path with a
visible-range mount, in the same spirit as Amp's `ListView` and OpenTUI's own
`getObjectsInViewport`:

1. Keep the full cached unit list (`transcriptUnits` WeakMap cache is already keyed
   by model identity — stop defeating it by rebuilding `boundedTranscriptModel`
   arrays).
2. Maintain a row→unit index (prefix sums over cached unit heights). On scroll or
   model change, compute `[firstVisibleUnit, lastVisibleUnit]` from
   `scrollTop + viewport`, and mount only that range plus overscan (1–2 screens),
   reusing revision-cached bundles (`transcriptUnitCache`).
3. Mount/dismount only the delta at the range edges; `reconcileTranscript` already
   diffs by key. The `maxMountedTranscriptRows` ceiling becomes a safety net that is
   never approached (mounted rows ≈ viewport + overscan).
4. `scrollTop` then ranges continuously over the full `scrollHeight`;
   `shiftTranscriptWindow`/`transcriptWindowEnd`/`boundedTranscriptModel` machinery
   is deleted from the scroll path (keep at most a hard safety cap for gigantic
   threads, e.g. 20k units, beyond which deep-history prefetch serves).
5. Keep the existing anchor machinery (`captureTranscriptAnchor`,
   `scheduleTranscriptPosition`, `prependedTranscriptItems`) — prepends adjust the
   window and restore the anchor, which already works and is tested.

This is what turns 687 ms initial render and 71 ms stream p95 into
visible-range costs (targets: ≤ 150 ms / ≤ 25 ms).

### Phase 4 — UX parity (from the researched frameworks)

Files: `packages/terminal/src/opentui/surface/opentui-surface-pointer.ts`,
`presentation/terminal/terminal-keymap.ts`, `state/reducer/terminal-keyboard-prelude.ts`.

1. Add `Home` (jump to absolute top; End already re-follows).
2. Add prompt-marker jumps (Pi parity): PageUp/PageDown-with-modifier or dedicated
   keys jump to the previous/next user-prompt unit (`turn:<id>:user` unit keys), via
   the row→unit index.
3. Wheel: keep the 16 ms settle for scrollbar sync but ensure a sustained scroll
   gesture accumulates deltas across the full loaded range with no I/O waits.
4. Confirm the scrollbar reflects full `scrollHeight` (it does via
   `syncTranscriptScrollbar`).

### Phase 5 — Tests, performance gates, verification

1. Update viewport/projection tests that assert the 120-unit/600-unit bounds:
   - `packages/product/test/interactive-thread-view-feed.test.ts` (boundedTurns
     removal),
   - `apps/rika/test/interactive-controller-page-order.test.ts` (extend beyond 120;
     prepend must no longer evict newest),
   - `packages/terminal/test/transcript-viewport.test.ts`,
     `transcript-follow-semantics.test.ts`, `opentui-transcript-prefetch.test.ts`,
     `integration/opentui-surface-characterization-*.test.ts` (mounted-window
     assertions → visible-range assertions).
2. New coverage:
   - `.tui.test.ts` (scripted model): a thread with ≥ 2,000 units; continuous
     wheel-up from bottom to top issues **zero** `LoadOlder` commands and reaches the
     top within N frames.
   - Ring-buffer eviction: a thread exceeding `transcriptMemoryCap` keeps the
     newest units, drops the oldest, and preserves the live tail + anchor.
   - Virtualization invariant: mounted renderables ≤ viewport + overscan for a
     10,000-unit model.
3. Performance gates (`packages/terminal/src/performance/terminal-performance-evaluation.ts`):
   add/keep `tui.initial-render ≤ 150 ms`, `tui.stream-update.p95 ≤ 25 ms`,
   `tui.scroll.p95 ≤ 12 ms`, mounted rows ≤ viewport + overscan.
4. Run `bun run check`, `bun run test-tui`, `bun run test-proc`, and the
   performance evaluation; report all results.

## Risks and mitigations

- **TUI-process memory**: bounded by `transcriptMemoryCap`. Measured cost is
  ≈ 2.5 KiB heap per unit (perf-eval heap delta: ~12.6 MiB for 5,005 items), so
  20,000 units ≈ 50 MiB heap — acceptable for a local TUI. The cap is one
  constant, tunable after real-world soak. The interactive idle-RSS budget
  (already over at 204 MiB vs 175) should be revisited in the same change.
- **Oldest content unreachable past the cap (accepted tradeoff)**: a thread with
  more than ~20k units shows only the newest 20k in the TUI; older content stays
  safe in the server's SQLite but is not viewable from the TUI. This is exactly
  OpenCode's model with a ~60× larger window, and matches the user's explicit
  preference: no background fetching complexity. Optional cheap mitigation: a dim
  one-line divider at the top of the loaded range (e.g. "Earlier history is not
  loaded") when the durable thread exceeds the cap, similar to Amp's compaction
  divider.
- **Wire contract break**: `ThreadViewSnapshot` schema caps change; greenfield
  project, breaking change is welcome. `packages/product/test/contract/...` schema
  tests must be updated in lockstep.
- **Anchor stability on prepend**: existing anchor/prepend machinery is retained and
  already tested; virtualization must keep unit-keyed anchors (it does).
- **Yoga cost with many mounted renderables**: mounted count becomes constant
  (viewport + overscan), which is the point of Phase 3.
- **Server encode cost for a full snapshot**: one-time per thread open; measure
  with the perf gate (`tui.initial-render`), and if needed stream the initial load
  as bounded pages that merge in place (the client path already supports prepends).

## Out of scope

- OpenTUI changes (`repos/*`, `node_modules/@opentui/*` are read-only references;
  `viewportCulling` stays enabled and is complemented by Rika-side mounting).
- Terminal-scrollback integration (native terminal scrollback is not the UX target).
- Compaction/truncation policies (unchanged; they bound content, not navigation).
