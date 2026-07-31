import { describe, expect, it } from "@effect/vitest"
import {
  RuntimeFixtures,
  TranscriptFixtures,
  Effect,
  Operation,
  createTurn,
  delegationUnit,
  storeProjection,
  collectEvents,
  completeActive,
  makeHarness,
} from "./interactive-session-base-support"
import { awaitSelectionLoaded } from "./interactive-session-reload-support"

describe("InteractiveSession controls", () => {
  it.effect("keeps earlier conversation Turns when a cancelled Turn's child units outnumber the wire page", () =>
    Effect.gen(function* () {
      const { session, turns, transcripts, older } = yield* makeHarness()
      yield* completeActive(turns, transcripts, 2)
      const conversation = [
        { id: "hey", prompt: "Hey", reply: "Hey! What can I help you with?", children: 0 },
        { id: "explore", prompt: "Explore this project", reply: "I’ll trace the current path flow.", children: 600 },
        { id: "followup", prompt: "Also note any tests that cover permissions.", reply: "Got it.", children: 0 },
        { id: "retry", prompt: "Explore this project", reply: "I’ll trace the permission enforcement.", children: 600 },
      ]
      for (const [index, entry] of conversation.entries()) {
        const created = yield* createTurn(turns, {
          id: RuntimeFixtures.Turn.TurnId.make(entry.id),
          threadId: older.id,
          prompt: entry.prompt,
          now: index + 10,
        })
        const completed = yield* turns.setStatus(created.id, "completed", undefined, index + 10)
        const childExecutionId = `child:${created.id}`
        const parent =
          entry.children === 0 ? undefined : delegationUnit(created.id, `delegate-${created.id}`, childExecutionId, 2)
        const units: Array<TranscriptFixtures.TranscriptUnit.Unit> = [
          TranscriptFixtures.TranscriptProjection.Projection.empty(created.id, entry.prompt).units[0]!,
          {
            key: `assistant:${created.id}:0`,
            turnId: created.id,
            order: TranscriptFixtures.TranscriptOrdering.unitOrder(`assistant:${created.id}:0`, 1),
            revision: 1,
            content: { _tag: "Entry", role: "assistant", text: entry.reply },
          },
          ...(parent === undefined ? [] : [parent]),
          ...Array.from({ length: entry.children }, (_, child): TranscriptFixtures.TranscriptUnit.Unit => {
            if (parent === undefined || parent.content._tag !== "Block" || parent.content.block._tag !== "ToolCall")
              throw new TypeError(`Turn ${created.id} has no child parent tool`)
            return TranscriptFixtures.TranscriptNestedProjection.attachUnit(
              {
                key: `${created.id}:child:${child.toString().padStart(3, "0")}`,
                turnId: childExecutionId,
                order: TranscriptFixtures.TranscriptOrdering.unitOrder(
                  `${created.id}:child:${child.toString().padStart(3, "0")}`,
                  child,
                ),
                revision: child,
                content: { _tag: "Block", block: { _tag: "Reasoning", text: `child ${child}` } },
              },
              parent,
              parent.content.block.id,
              childExecutionId,
            )
          }),
        ]
        yield* storeProjection(transcripts, completed, {
          ...TranscriptFixtures.TranscriptProjection.Projection.empty(created.id, created.prompt),
          units,
          revision: units.length,
        })
      }
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      const expectedRootKeys = conversation.flatMap((entry) => [`turn:${entry.id}:user`, `assistant:${entry.id}:0`])
      const initial = yield* awaitSelectionLoaded(events, (event) => {
        const keys = new Set(event.entries.map((entry) => entry.unit.key))
        return expectedRootKeys.every((key) => keys.has(key))
      })
      const loaded = initial.entries
      const keys = new Set(loaded.map((entry) => entry.unit.key))
      for (const entry of conversation) {
        expect(keys.has(`turn:${entry.id}:user`)).toBe(true)
        expect(keys.has(`assistant:${entry.id}:0`)).toBe(true)
      }
      const newest = loaded.filter((entry) => entry.turn.id === "retry")
      expect(newest.length).toBeLessThanOrEqual(400)
      expect(newest.filter((entry) => entry.unit.parentId !== undefined).length).toBeGreaterThan(0)
      expect(loaded.filter((entry) => entry.turn.id === "explore" && entry.unit.parentId !== undefined)).toHaveLength(0)
      expect(keys.size).toBe(loaded.length)
      expect(initial.hasOlder).toBe(true)
    }),
  )

  it.effect("projects control failures instead of failing the session effect", () =>
    Effect.gen(function* () {
      const { session } = yield* makeHarness()
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread("missing", 1)
      yield* session.steer("nowhere")
      yield* session.editQueued("missing", "no")
      yield* Effect.yieldNow
      const failures = events.filter((event) => event._tag === "ExecutionFailed")
      expect(failures).toHaveLength(3)
      expect(failures[0]).toMatchObject({ message: expect.stringContaining("Thread missing does not exist") })
      expect(failures[1]).toMatchObject({ message: expect.stringContaining("No thread selected") })
      expect(failures[2]).toMatchObject({ message: expect.stringContaining("is not queued") })
    }),
  )

  it.effect("keeps the active turn running when the cancellation request fails", () =>
    Effect.gen(function* () {
      const { session, turns, older } = yield* makeHarness(undefined, false, undefined, true)
      const events: Array<Operation.InteractiveEvent> = []
      yield* collectEvents(session, events)
      yield* session.selectThread(older.id, 1)
      events.length = 0
      yield* session.cancel
      yield* Effect.yieldNow
      expect(events).toContainEqual(expect.objectContaining({ _tag: "ExecutionControlFailed", action: "cancel" }))
      expect(events.some((event) => event._tag === "ExecutionFailed")).toBe(false)
      expect(yield* turns.findActive(older.id)).toMatchObject({ status: "running" })
    }),
  )
})
