import { describe, expect, it } from "@effect/vitest"
import {
  Fixtures,
  Deferred,
  Effect,
  ExecutionIngest,
  threadId,
  rootId,
  checkpoint,
  event,
  started,
  rootEvents,
  makeHarness,
  settle,
} from "./execution-ingest-behavior-support"

describe("ExecutionIngest", () => {
  it.effect("finishes a held catch-up page before recording terminal state and drops stale stored units", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const paged: ReadonlyArray<Fixtures.ExecutionBackend.Event> = [
        started("root"),
        event("root", "p1", 1, "model.output.completed", { text: "replayed one" }),
        event("root", "p2", 2, "model.output.completed", { text: "replayed two" }),
        event("root", "p3", 3, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: {
            events: paged,
            status: "running",
            pages: (after) => {
              const boundary = after === undefined ? -1 : paged.findIndex((candidate) => candidate.cursor === after)
              const next = paged[boundary + 1]
              return next === undefined
                ? { events: [], hasMore: false, ...(after === undefined ? {} : { newestCursor: after }) }
                : { events: [next], hasMore: boundary + 2 < paged.length, newestCursor: next.cursor }
            },
          },
        },
        turnStatus: "running",
        stored: Fixtures.TranscriptProjection.Projection.project("root", "stale stored prompt", [
          event("root", "stale", 9, "model.output.completed", { text: "stale stored content" }),
        ]),
        pageHold: { after: "p1", open: gate },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow
      expect(checkpoint(yield* transcripts.get(rootId), "root")?.status).toBeUndefined()

      yield* Deferred.succeed(gate, undefined)
      yield* settle(ingest)

      const stored = yield* transcripts.get(rootId)
      expect(checkpoint(stored, "root")).toEqual(
        expect.objectContaining({ cursor: "p3", sequence: 3, status: "completed" }),
      )
      expect(
        stored?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "stale stored content"),
      ).toBe(false)
      expect(stored?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "replayed two")).toBe(
        true,
      )
      expect(stored?.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "delegate")).toBe(true)
    }),
  )

  for (const malformedTerminal of ["empty", "nonadvancing"] as const)
    it.effect(`reports a typed failure and stops after a ${malformedTerminal} continuation page`, () =>
      Effect.gen(function* () {
        const failures: Array<ExecutionIngest.Failure> = []
        const paged = [
          event("root", "r1", 1, "model.output.completed", { text: "one" }),
          event("root", "r2", 2, "model.output.completed", { text: "two" }),
        ]
        const { ingest, transcripts } = yield* makeHarness({
          script: {
            root: {
              events: paged,
              status: "running",
              pages: (after) => {
                if (after === undefined) return { events: paged.slice(0, 1), hasMore: true, newestCursor: "r1" }
                if (malformedTerminal === "empty") return { events: [], hasMore: true, newestCursor: "r2" }
                return { events: paged.slice(1, 2), hasMore: true, newestCursor: after }
              },
            },
          },
          turnStatus: "running",
          onFailure: (failure) => failures.push(failure),
        })

        yield* ingest.ensure({ threadId, turnId: rootId })
        const failure = yield* Effect.flip(ingest.consumed(rootId))

        expect(failures).toHaveLength(1)
        expect(failure).toBe(failures[0])
        expect(failures[0]?.reason).toBe("backend")
        expect(failures[0]?.executionId).toBe("root")
        expect(failures[0]?.message).toContain("did not advance")
        expect(checkpoint(yield* transcripts.get(rootId), "root")?.status).toBeUndefined()
      }),
    )

  it.effect("ignores a queued turn and a turn that no longer exists", () =>
    Effect.gen(function* () {
      const { ingest, follows } = yield* makeHarness({
        script: { root: { events: rootEvents, status: "completed" } },
        turnStatus: "queued",
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.ensure({ threadId, turnId: Fixtures.Turn.TurnId.make("absent") })
      yield* settle(ingest)

      expect(follows).toHaveLength(0)
    }),
  )
})
