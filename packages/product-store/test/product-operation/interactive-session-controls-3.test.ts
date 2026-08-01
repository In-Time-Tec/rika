import type { InteractiveEvent } from "@rika/product/interactive-event"
import { describe, expect, it } from "@effect/vitest"
import * as TurnContract from "@rika/product/turn-repository"
import { Fixtures as RuntimeFixtures } from "./interactive-session-runtime-support"
import { Fixtures as TranscriptFixtures } from "./interactive-session-transcript-support"
import { Effect, Ref, Schema } from "effect"
import { projectionVersion, collectEvents } from "./interactive-session-base-support"
import { createTurn } from "../support/product-test-current-state"
import { delegationUnit, storeProjection } from "../support/product-test-transcript-fixture"
import { storeCompletedTranscript, completeActive } from "./interactive-session-completion-support"
import { makeHarness } from "./interactive-session-harness-support"
import {
  awaitSelectionEntries,
  awaitSelectionLoaded,
  awaitPrependedPage,
} from "./interactive-session-selection-support"

describe("InteractiveSession controls", () => {
  it.effect("selects a thread and reopens the latest persisted projection without raw replay", () =>
    Effect.gen(function* () {
      const { session, controls, older } = yield* makeHarness(undefined, false, undefined, false, true)
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* session.reopenThread(2)
      while (!events.some((event) => event._tag === "ThreadUsageUpdated" && event.selectionEpoch === 2))
        yield* Effect.yieldNow
      const reopened = yield* awaitSelectionEntries(events, (entries) =>
        entries.some((entry) => entry.turn.id === "latest-active"),
      )
      expect(events.some((event) => event._tag === "SelectionLoaded" && event.thread.id === "older")).toBe(true)
      expect(reopened.map((entry) => entry.turn.id)).toEqual(["latest-active"])
      expect(events.filter((event) => event._tag === "TranscriptProjectionPatched")).toEqual([])
      expect(events.find((event) => event._tag === "ThreadUsageUpdated" && event.selectionEpoch === 2)).toEqual({
        _tag: "ThreadUsageUpdated",
        selectionEpoch: 2,
        threadId: "latest",
        revision: 0,
        context: { _tag: "Unavailable" },
        cost: { _tag: "Unavailable" },
        tokens: { _tag: "Unavailable" },
        time: { _tag: "Unavailable" },
      })
      expect(yield* Ref.get(controls)).toEqual([])
    }),
  )

  it.effect("projects one Turn incrementally from bounded forward event pages", () =>
    Effect.gen(function* () {
      const pagedEvents = Array.from(
        { length: 450 },
        (_, index): RuntimeFixtures.ExecutionEvent.Event => ({
          executionId: "execution:active",
          cursor: `cursor-${index + 1}`,
          sequence: index + 1,
          type: "model.output.completed",
          createdAt: index + 1,
          text: `event ${index + 1}`,
        }),
      )
      const { session, controls, older } = yield* makeHarness(pagedEvents)
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      const received = yield* awaitSelectionEntries(
        events,
        (entries) => entries.filter((entry) => entry.turn.id === "active").length >= 2,
      )
      const projected = received.filter((entry) => entry.turn.id === "active")
      expect(projected).toHaveLength(2)
      expect(projected.at(-1)?.unit).toMatchObject({
        revision: 450,
        content: { _tag: "Entry", role: "assistant", text: "event 450" },
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["page", "active", "forward", undefined, 200],
        ["page", "active", "forward", "cursor-200", 200],
        ["page", "active", "forward", "cursor-400", 200],
      ])
    }),
  )

  it.effect("stops ingesting and reports a failure when forward paging stops advancing", () =>
    Effect.gen(function* () {
      const pagedEvents = Array.from(
        { length: 450 },
        (_, index): RuntimeFixtures.ExecutionEvent.Event => ({
          executionId: "execution:active",
          cursor: `cursor-${index + 1}`,
          sequence: index + 1,
          type: "model.output.completed",
          createdAt: index + 1,
          text: `event ${index + 1}`,
        }),
      )
      const { session, controls, older } = yield* makeHarness(pagedEvents, true)
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      expect(events.find((event) => event._tag === "ExecutionFailed")).toMatchObject({
        threadId: older.id,
        turnId: RuntimeFixtures.Turn.TurnId.make("active"),
        message: expect.stringContaining("lost its place"),
      })
      expect(yield* Ref.get(controls)).toEqual([
        ["page", "active", "forward", undefined, 200],
        ["page", "active", "forward", "cursor-200", 200],
      ])
    }),
  )

  it.effect("keeps queued turns in the queue and out of the transcript when selecting a thread", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, controls, older } = yield* makeHarness()
      const queued = yield* createTurn(turns, {
        id: RuntimeFixtures.Turn.TurnId.make("queued-selection"),
        threadId: older.id,
        prompt: "queued prompt",
        now: 2,
      })
      const shell: RuntimeFixtures.ThreadResult.TerminalRecordedShellTurn = {
        _tag: "RecordedShell",
        id: RuntimeFixtures.Turn.TurnId.make("recorded-shell"),
        threadId: older.id,
        prompt: "$ printf recorded",
        command: "printf recorded",
        author: { _tag: "Human" },
        lineage: { _tag: "Original" },
        status: "completed",
        stopIntent: "none",
        createdAt: 3,
        updatedAt: 4,
        result: { text: "output:recorded", truncated: false },
      }
      yield* transcripts.copyRecordedShell(shell, projectionVersion)
      yield* completeActive(turns, transcripts, 5)
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow

      expect(events.find((event) => event._tag === "SelectionLoaded")).toMatchObject({ queue: [{ id: queued.id }] })
      const entries = yield* awaitSelectionEntries(events, (loaded) => loaded.length >= 2)
      expect(entries).toMatchObject([
        { turn: { id: "active" }, unit: { content: { _tag: "Entry" } } },
        {
          turn: { id: shell.id },
          unit: { content: { _tag: "Block", block: { _tag: "ToolCall", output: "output:recorded" } } },
        },
      ])
      expect(entries.some((entry) => entry.turn.id === queued.id)).toBe(false)
      expect(entries.some((entry) => entry.turn.id === shell.id)).toBe(true)
      expect(yield* Ref.get(controls)).toEqual([])
    }),
  )

  it.effect("bounds the initial page and exhausts older pages without duplicate units", () =>
    Effect.gen(function* () {
      const turnPageRequests = yield* Ref.make<ReadonlyArray<typeof TurnContract.PageCursor.Type | undefined>>([])
      const { session, turns, transcripts, older } = yield* makeHarness(undefined, false, turnPageRequests)
      yield* completeActive(turns, transcripts, 2)
      for (let index = 0; index < 240; index += 1) {
        const created = yield* createTurn(turns, {
          id: RuntimeFixtures.Turn.TurnId.make(`history-${index.toString().padStart(3, "0")}`),
          threadId: older.id,
          prompt: `history ${index}`,
          now: index + 10,
        })
        const completed = yield* turns.setStatus(created.id, "completed", undefined, index + 10)
        yield* storeCompletedTranscript(transcripts, completed, `history-${index}-done`)
      }
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      yield* Effect.yieldNow
      const initial = events.find((event) => event._tag === "SelectionLoaded")
      expect(initial?._tag === "SelectionLoaded" ? initial.hasOlder : false).toBe(true)
      if (initial?._tag !== "SelectionLoaded" || initial.oldestCursor === undefined)
        return yield* Effect.die("missing initial transcript cursor")
      const loaded = initial?._tag === "SelectionLoaded" ? [...initial.entries] : []
      expect(loaded.length).toBeGreaterThan(0)
      expect(loaded.length).toBeLessThanOrEqual(200)
      const turnPagesBeforeIdle = (yield* Ref.get(turnPageRequests)).length
      for (let attempt = 0; attempt < 100; attempt += 1) yield* Effect.yieldNow
      expect(yield* Ref.get(turnPageRequests)).toHaveLength(turnPagesBeforeIdle)
      yield* session.loadOlder(
        "different-thread",
        1,
        initial.oldestCursor,
        loaded.map((entry) => entry.unit.key),
      )
      yield* session.loadOlder(
        older.id,
        2,
        initial.oldestCursor,
        loaded.map((entry) => entry.unit.key),
      )
      expect(yield* Ref.get(turnPageRequests)).toHaveLength(turnPagesBeforeIdle)
      let hasOlder = true
      let before = initial.oldestCursor
      for (let page = 0; page < 10 && hasOlder; page += 1) {
        const previous = events.filter((event) => event._tag === "TranscriptPagePrepended").length
        yield* session.loadOlder(
          older.id,
          1,
          before,
          loaded.map((entry) => entry.unit.key),
        )
        for (
          let attempt = 0;
          attempt < 400 && events.filter((event) => event._tag === "TranscriptPagePrepended").length === previous;
          attempt += 1
        )
          yield* Effect.yieldNow
        const prepended = events.findLast((event) => event._tag === "TranscriptPagePrepended")
        if (prepended?._tag !== "TranscriptPagePrepended") break
        loaded.unshift(...prepended.entries)
        hasOlder = prepended.hasOlder
        if (prepended.oldestCursor !== undefined) before = prepended.oldestCursor
      }
      expect(hasOlder).toBe(false)
      expect(new Set(loaded.map((entry) => entry.unit.key)).size).toBe(loaded.length)
      expect(loaded.some((entry) => entry.unit.key === "turn:active:user")).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === "turn:history-000:user")).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === "turn:history-239:user")).toBe(true)
      expect(yield* Ref.get(turnPageRequests)).toHaveLength(turnPagesBeforeIdle)
      expect(events.filter((event) => event._tag === "TranscriptPagePrepended").length).toBeGreaterThan(0)
    }),
  )

  it.effect("stops the initial semantic page at the nearest Turn boundary", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* completeActive(turns, transcripts, 2)
      for (let turnIndex = 0; turnIndex < 5; turnIndex += 1) {
        const created = yield* createTurn(turns, {
          id: RuntimeFixtures.Turn.TurnId.make(`boundary-${turnIndex}`),
          threadId: older.id,
          prompt: `boundary ${turnIndex}`,
          now: turnIndex + 10,
        })
        const completed = yield* turns.setStatus(created.id, "completed", undefined, turnIndex + 10)
        const units: Array<TranscriptFixtures.TranscriptUnit.Unit> = [
          TranscriptFixtures.TranscriptProjection.Projection.empty(created.id, created.prompt).units[0]!,
          ...Array.from(
            { length: 72 },
            (_, index): TranscriptFixtures.TranscriptUnit.Unit => ({
              key: `${created.id}:assistant:${index.toString().padStart(2, "0")}`,
              turnId: created.id,
              order: TranscriptFixtures.TranscriptOrdering.unitOrder(
                `${created.id}:assistant:${index.toString().padStart(2, "0")}`,
                index + 1,
              ),
              revision: index + 1,
              content: { _tag: "Entry", role: "assistant", text: `${created.id} ${index} ${"x".repeat(50_000)}` },
            }),
          ),
        ]
        yield* storeProjection(transcripts, completed, {
          ...TranscriptFixtures.TranscriptProjection.Projection.empty(created.id, created.prompt),
          units,
          revision: 72,
        })
      }
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      const initial = yield* awaitSelectionLoaded(
        events,
        (event) => event.entries.length > 0 && event.oldestCursor !== undefined,
      )
      const loaded = initial.entries
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(initial)
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(10 * 1024 * 1024)
      expect(loaded.length).toBeGreaterThan(0)
      expect(loaded[0]?.unit.key).toBe(`turn:${loaded[0]?.turn.id}:user`)
      expect(initial.hasOlder).toBe(true)
      if (initial.oldestCursor === undefined) return yield* Effect.die("missing initial transcript cursor")

      const pagesBefore = events.filter((event) => event._tag === "TranscriptPagePrepended").length
      yield* session.loadOlder(
        older.id,
        1,
        initial.oldestCursor,
        loaded.map((entry) => entry.unit.key),
      )
      const prepended = yield* awaitPrependedPage(events, pagesBefore)
      const olderEntries = prepended.entries
      expect(olderEntries).toHaveLength(50)
      expect(olderEntries.at(-1)?.unit.key).not.toBe(loaded[0]?.unit.key)
      expect(new Set([...olderEntries, ...loaded].map((entry) => entry.unit.key)).size).toBe(
        olderEntries.length + loaded.length,
      )
    }),
  )

  it.effect("keeps a prior conversation boundary when nested units crowd the newest Turn past the wire page", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* completeActive(turns, transcripts, 2)
      const created = yield* createTurn(turns, {
        id: RuntimeFixtures.Turn.TurnId.make("oversized"),
        threadId: older.id,
        prompt: "oversized prompt",
        now: 10,
      })
      const completed = yield* turns.setStatus(created.id, "completed", undefined, 10)
      const childExecutionId = `child:${created.id}`
      const parent = delegationUnit(created.id, "nested-agent", childExecutionId, 2)
      if (parent.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
        return yield* Effect.die("missing nested parent tool")
      const parentId = parent.content.block.id
      const units: Array<TranscriptFixtures.TranscriptUnit.Unit> = [
        TranscriptFixtures.TranscriptProjection.Projection.empty(created.id, created.prompt).units[0]!,
        {
          key: `${created.id}:assistant:opening`,
          turnId: created.id,
          order: TranscriptFixtures.TranscriptOrdering.unitOrder(`${created.id}:assistant:opening`, 1),
          revision: 1,
          content: { _tag: "Entry", role: "assistant", text: "opening response" },
        },
        {
          key: `compaction:${created.id}`,
          turnId: created.id,
          order: TranscriptFixtures.TranscriptOrdering.unitOrder(`compaction:${created.id}`, 1, 1),
          revision: 2,
          content: {
            _tag: "Block",
            block: {
              _tag: "Compaction",
              summary: "Earlier thread context was compacted.",
              status: "complete",
              checkpoint: "checkpoint-oversized",
            },
          },
        },
        parent,
        ...Array.from(
          { length: 260 },
          (_, index): TranscriptFixtures.TranscriptUnit.Unit =>
            TranscriptFixtures.TranscriptNestedProjection.attachUnit(
              {
                key: `${created.id}:assistant:${index.toString().padStart(3, "0")}`,
                turnId: childExecutionId,
                order: TranscriptFixtures.TranscriptOrdering.unitOrder(
                  `${created.id}:assistant:${index.toString().padStart(3, "0")}`,
                  index,
                ),
                revision: index,
                content: {
                  _tag: "Block",
                  block: { _tag: "Notification", title: String(index), detail: "x".repeat(40_000) },
                },
              },
              parent,
              parentId,
              childExecutionId,
            ),
        ),
        {
          key: `${created.id}:assistant:final`,
          turnId: created.id,
          order: TranscriptFixtures.TranscriptOrdering.unitOrder(`${created.id}:assistant:final`, 262),
          revision: 262,
          content: { _tag: "Entry", role: "assistant", text: "final response" },
        },
      ]
      yield* storeProjection(transcripts, completed, {
        ...TranscriptFixtures.TranscriptProjection.Projection.empty(created.id, created.prompt),
        units,
        revision: 262,
      })
      const events: Array<InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      const initial = yield* awaitSelectionLoaded(
        events,
        (event) =>
          event.oldestCursor !== undefined && event.entries.some((entry) => entry.unit.key === "turn:active:user"),
      )
      const loaded = initial.entries
      const cursor = initial.oldestCursor
      if (cursor === undefined) return yield* Effect.die("missing initial transcript cursor")
      const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(initial)
      expect(new TextEncoder().encode(encoded).byteLength).toBeLessThan(10 * 1024 * 1024)
      expect(loaded.some((entry) => entry.unit.key === "turn:active:user")).toBe(true)
      expect(loaded.filter((entry) => entry.unit.key === "turn:active:user")).toHaveLength(1)
      expect(loaded.some((entry) => entry.unit.key === `turn:${created.id}:user`)).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === `${created.id}:assistant:opening`)).toBe(true)
      expect(loaded.some((entry) => entry.unit.key === `${created.id}:assistant:final`)).toBe(true)
      expect(loaded.filter((entry) => entry.unit.key === `compaction:${created.id}`)).toHaveLength(1)
      expect(cursor.orderKey).not.toBe(
        TranscriptFixtures.TranscriptOrdering.encodeUnitOrder(
          TranscriptFixtures.TranscriptOrdering.unitOrder(`turn:${created.id}:user`, 0),
        ),
      )

      const olderEntries: Array<RuntimeFixtures.TranscriptPage.Entry> = []
      let hasOlder = initial.hasOlder
      let before = cursor
      for (let page = 0; page < 20 && hasOlder; page += 1) {
        const previousPages = events.filter((event) => event._tag === "TranscriptPagePrepended").length
        yield* session.loadOlder(
          older.id,
          1,
          before,
          [...olderEntries, ...loaded].map((entry) => entry.unit.key),
        )
        for (
          let attempt = 0;
          attempt < 400 && events.filter((event) => event._tag === "TranscriptPagePrepended").length === previousPages;
          attempt += 1
        )
          yield* Effect.yieldNow
        const prepended = events.findLast((event) => event._tag === "TranscriptPagePrepended")
        if (prepended?._tag !== "TranscriptPagePrepended") break
        olderEntries.unshift(...prepended.entries)
        hasOlder = prepended.hasOlder
        if (prepended.oldestCursor !== undefined) before = prepended.oldestCursor
      }
      expect(olderEntries.length).toBeGreaterThan(0)
      const cursorEntry = loaded.find(
        (entry) => TranscriptFixtures.TranscriptOrdering.encodeUnitOrder(entry.unit.order) === cursor.orderKey,
      )
      expect(
        TranscriptFixtures.TranscriptOrdering.compareUnitOrder(
          olderEntries.at(-1)!.unit.order,
          cursorEntry!.unit.order,
        ),
      ).toBeLessThan(0)
      const allEntries = [...olderEntries, ...loaded]
      expect(new Set(allEntries.map((entry) => entry.unit.key)).size).toBe(allEntries.length)
      expect(allEntries.filter((entry) => entry.unit.parentId === parentId)).toHaveLength(260)
      expect(hasOlder).toBe(false)
    }),
  )
})
