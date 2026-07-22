# Plan 018: Subagent transcripts survive restart — self-healing, additive backfill

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (plan 006 touches the same repository but a different behavior)
- **Category**: bug (user-visible data loss on reload)
- **Planned at**: commit `ee4163d`, 2026-07-22
- **Executed**: 2026-07-22, same working tree. The design changed during
  execution — see "Design" for the shipped shape and the rejected alternative.

## Symptom

While a turn streams live, a subagent row ("Oracle has spoken ▸") expands to
its nested tool calls and its final message renders as styled markdown. After
quitting and reopening Rika (or continuing the thread later), the same row has
no nested tools, shows the raw prompt as plain text, and the final message
degrades to "The subagent finished without a final message."

## Root cause (verified against a production `~/.rika` on 2026-07-22)

Live and reload take different data paths:

- **Live**: child execution events stream as `TranscriptPatched` events with the
  child's execution id; the TUI keeps a separate child projection per subagent
  and stitches it under the parent tool at render time
  (`TranscriptPresenter.attachChildProjections`). Nothing nested is persisted
  by this path — `rootExecutionEvents` (`packages/app/src/operation.ts:575`)
  strips child cursors before `appendAll`.
- **Reload**: rendering depends entirely on persisted units carrying
  `parentId`. Those are only ever written by the settle-time
  `persistExecutionTree` (`operation.ts:846`), which re-replays every child
  execution from the backend and `transcripts.replace`s the whole turn.

Three verified defects break the reload path:

1. **Spawn events never link the persisted parent tool.**
   `applyChild` (`packages/transcript/src/index.ts:490`) matches a
   `child_run.spawned` to its requesting tool via `childToolCallId`, which
   requires a literal `:child:` inside the child execution id. Relay's current
   format is `child:execution%3A<turnId>:<callId>` (colon percent-encoded), so
   the match always fails when the payload has no `tool_call_id` — production
   payloads have none. The persisted tool keeps `childId: null` and a stray
   `ChildAgent` unit is stored instead. (`childParentMatch` already parses this
   format correctly via `childScopeAndCallId`; `applyChild` just doesn't use
   it.)
2. **An empty child projection counts as "present", so broken trees are
   sticky.** `hasMissingNestedProjection` (`operation.ts:613`) accepts any
   nested unit with `revision >= 0`. `Transcript.empty()` produces the child's
   `turn:<childId>:user` entry with revision 0 and empty text, so once an empty
   child subtree is persisted, the `force=false` repair on thread load never
   runs again. Production data: every recent turn's nested units are ONLY these
   empty user entries — zero nested tool blocks, zero assistant answers — while
   `relay.db` still holds the full child event logs (e.g. 4,788 events for one
   Oracle child of turn `d3d9bda8`).
3. **A force rebuild clobbers good data with an empty replay.** The
   `force=true` call sites (`operation.ts:2036/2350/2498/2705/3743`) rebuild
   the tree from live backend replay and `transcripts.replace` the result. If
   `replayProjection` returns no events for a child (observed in production:
   the resident logged `execution.child.parent_synthesized` at 18:33:21, ~400ms
   after resident start, and persisted empty child subtrees even though the
   events exist in `relay.db`), the replace destroys whatever nested units were
   previously persisted. Related data-loss on the same path: when
   `backend.inspect(turn.id)` returns `undefined`, `projectTurnPage`
   (`operation.ts:2698`) replaces the entire stored transcript with
   `Transcript.empty` even when a stored projection exists.

Why the child replay returned zero events on that resident start is still
unconfirmed (the Relay SDK's `pageEvents` → repository query is a plain
`execution_id = ?` select and the rows exist). The design below removes the
dependency on that replay instead of betting on its cause; step 5 adds a
diagnostic so production tells us.

## Failing tests (already committed by this change)

Run each; all three must fail before you start and pass when you finish:

```sh
bun --bun vitest run packages/transcript/test/projection.test.ts -t "percent-encoded"
bun --bun vitest run packages/app/test/interactive-session.test.ts -t "repairs a persisted subagent tree"
bun --bun vitest run packages/app/test/interactive-session.test.ts -t "keeps persisted subagent transcripts"
```

1. `projection.test.ts` — "links a child spawn with a percent-encoded parent
   execution id to the requesting tool": defect 1.
2. `interactive-session.test.ts` — "repairs a persisted subagent tree whose
   child transcript is empty": defect 2, seeded with the exact production
   shape (unlinked tool + `ChildAgent` unit + empty nested user entry).
3. `interactive-session.test.ts` — "keeps persisted subagent transcripts when
   the backend can no longer replay the child": defect 3.

## Design (as shipped)

The invariant, stated once so the next change preserves it: **Relay owns the
durable child event logs; Rika's persisted transcript tree is a projection of
them, and re-projecting on load may only enrich it, never degrade it.** Reload
correctness comes from a self-healing backfill: every thread load re-checks
whether any recorded child still lacks a real transcript and retries the
backfill until the tree is complete. An empty or failed child replay is never
persisted and never overwrites stored data, so a bad backfill costs nothing
and the next load tries again.

A second streaming-persistence path (persisting child events as they arrive)
was in the original plan and was **rejected during execution**: child events
carry their own sequence numbers, so appending them through the root turn's
`appendAll` would fight the root projection's revision monotonicity, and a
separate child store would duplicate what Relay already owns durably. The
child followers are also selection-scoped, so streaming persistence would
still have needed the backfill for unselected threads — at which point the
backfill must be correct on its own, and once it is, the streaming path adds
only complexity.

### Shipped changes

1. **One owner for parent↔child matching**
   (`packages/transcript/src/index.ts`). `childParentMatch` is the single
   matcher: linked `childId` equality (preferring a real requesting tool over
   a synthesized twin), then scope-strict agent-family call-id match.
   `applyChild`, `settleChild`, and `ensureChildTool` all resolve parents
   through it via `linkedToolFor`/`toolCandidates`; the duplicate broken
   parsers (`childToolCallId`, `childToolAt`) are deleted. Cross-scope
   matching stays forbidden (existing tests assert it); the single-turn
   `linkedToolFor` adds a turn-scoped raw-call-id fallback that preserves the
   old handoff-format behavior.
2. **Additive, self-healing backfill** (`packages/app/src/operation.ts`).
   `backfillTranscriptTree` (was `persistExecutionTree`) → 
   `backfillChildTranscripts` (was `projectExecutionTree`):
   - `hasChildrenAwaitingBackfill` (was `hasMissingNestedProjection`) finds
     expected children from linked tools **and** legacy `ChildAgent` units,
     and counts a child present only when it has a real nested unit (a Block,
     or an Entry with text) — empty prompt husks no longer satisfy it.
   - A child replay with no events is logged (`execution.child.replay_empty`)
     and skipped: no husk units, no synthesized parent, nothing replaced.
   - Per child, the richer of {stored units, replayed projection} wins (by
     revision); stored children the backend no longer reports are preserved
     verbatim.
   - Synthesized twin tools left by the old code are dropped once their child
     re-attaches to the real requesting tool (`withoutSynthesizedTwins`).
   - `projectTurnPage` only seeds `Transcript.empty` when no projection is
     stored; a stored transcript is never wiped because the backend lost the
     execution.
3. **Legacy data heals with no migration.** On thread load the `force=false`
   backfill fires for old rows (husk-only children, `childId: null` tools with
   `ChildAgent` units), re-replays from `relay.db`, attaches under the real
   tools, and removes the synthesized duplicates.
4. **The root cause of the empty replays was the lazy backend facade**
   (`apps/rika/src/main.ts`): it dropped the optional `reference` parameter on
   `replay`/`inspect`/`cancel`/`steer`/`listApprovals` and did not expose
   `pageEvents`, so child ids were re-prefixed to `execution:child:...` and
   every child replay returned zero events in the installed app — while tests,
   which wire the backend without the facade, stayed green. The facade now
   forwards the full contract and a regression test
   (`apps/rika/test/lazy-backend.test.ts`) drives it against a recording
   backend.
5. **Backfill runs off the selection load.** With real replays restored, a
   first load after upgrade would otherwise replay thousands of events before
   `SelectionLoaded` could dispatch. `projectTurnPage` now defers backfill and
   terminal-turn healing to a forked session task; when the backfill writes,
   it dispatches `TranscriptResyncRequired` and the client re-selects.
   `recordedChildIds` only considers root-level units so a healed tree with
   unreplayable grandchildren cannot re-trigger the backfill forever.
6. **Nested units page under their storage turn, not their projection turn.**
   The SQL `page` keyset orders by `u.turn_id` (nested units are stored under
   the root turn), but it decoded the entry's `turn.id` from `unit.turnId`
   (the child execution id), so `cursorFor` produced a cursor that could not
   round-trip: `loadTranscriptPage`'s boundary loop re-fetched the same page
   forever once a turn held more nested units than the page limit — the
   installed app hung on "Loading Thread". `page` now takes `turn.id` from the
   stored `u.turn_id`, matching the in-memory repository. A persistence test
   keyset-paginates a subagent tree whose nested units outnumber the page and
   asserts full, duplicate-free coverage. This defect was latent until steps 1
   and 4 first persisted many real nested units per turn.

The `execution.child.replay_empty` diagnostic answers the one open question
(why a resident-start replay returned zero events for children whose events
exist). Remove condition: once production logs show the cause — or the event
stops appearing — record the finding if it changed anything and delete the log
if it is noise.

## Verification (executed 2026-07-22)

- `bun --bun vitest run packages/transcript/test/` — 54/54 pass (was 1 red).
- `bun --bun vitest run packages/app/test packages/tui/test packages/transcript/test packages/persistence/test`
  — all pass (was 2 red) except one unrelated red test belonging to a
  concurrent work stream (verified red without these changes).
- `bun --bun vitest run apps/rika/test packages/runtime/test` — all pass
  except one unrelated concurrent-stream red test in
  `execution-backend-relay.test.ts`.
- Per-package `bun run typecheck` on transcript, app, tui, and apps/rika —
  clean. `bun run format` applied.
- Not run: `bun run test-proc`, `bun run release-smoke`, and manual pilotty
  acceptance (run a subagent turn, quit, reopen, reselect the thread; the row
  must expand to nested tools with the styled final message).

## STOP conditions (for follow-up work)

- If nested-unit ordering under `page` pagination cannot be kept stable without
  schema changes (a new column on `rika_transcript_units`), stop and get the
  migration reviewed first — `@rika/persistence` requires additive migrations.
- The concurrent uncommitted edits to `packages/app/test/operation.test.ts`
  and `packages/runtime/test/execution-backend-relay.test.ts` belong to
  another work stream; if they conflict with your changes, stop and report.

## Out of scope

- TUI rendering (`transcript-presenter`, `adapter.ts`) — proven correct: it
  renders nested tools and markdown whenever the persisted units exist.
- Relay SDK changes (`repos/*`, released packages).
- The husk-requeue follow-up tracked in `ISSUES.md`.
