import { describe, expect, it } from "@effect/vitest"
import { makeHarness, settle } from "./execution-ingest-behavior-support"

import { ExecutionFixtures } from "./execution-ingest-fixtures"

import { Fixtures } from "./execution-ingest-support"
import * as ExecutionIngest from "../../src/execution/ingest/execution-ingest-service"
import { Context, Deferred, Effect, Exit, Layer, Ref, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"

describe("ExecutionIngest", () => {
  it.effect("finishes a held catch-up page before recording terminal state and drops stale stored units", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>()
      const paged: ReadonlyArray<Fixtures.ExecutionBackend.Event> = [
        ExecutionFixtures.started("root"),
        ExecutionFixtures.event("root", "p1", 1, "model.output.completed", { text: "replayed one" }),
        ExecutionFixtures.event("root", "p2", 2, "model.output.completed", { text: "replayed two" }),
        ExecutionFixtures.event("root", "p3", 3, "execution.completed"),
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
          ExecutionFixtures.event("root", "stale", 9, "model.output.completed", { text: "stale stored content" }),
        ]),
        pageHold: { after: "p1", open: gate },
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow
      expect(
        ExecutionFixtures.checkpoint(yield* transcripts.get(ExecutionFixtures.rootId), "root")?.status,
      ).toBeUndefined()

      yield* Deferred.succeed(gate, undefined)
      yield* settle(ingest)

      const stored = yield* transcripts.get(ExecutionFixtures.rootId)
      expect(ExecutionFixtures.checkpoint(stored, "root")).toEqual(
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
          ExecutionFixtures.event("root", "r1", 1, "model.output.completed", { text: "one" }),
          ExecutionFixtures.event("root", "r2", 2, "model.output.completed", { text: "two" }),
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

        yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
        const failure = yield* Effect.flip(ingest.consumed(ExecutionFixtures.rootId))

        expect(failures).toHaveLength(1)
        expect(failure).toBe(failures[0])
        expect(failures[0]?.reason).toBe("backend")
        expect(failures[0]?.executionId).toBe("root")
        expect(failures[0]?.message).toContain("did not advance")
        expect(
          ExecutionFixtures.checkpoint(yield* transcripts.get(ExecutionFixtures.rootId), "root")?.status,
        ).toBeUndefined()
      }),
    )

  it.effect("ignores a queued turn and a turn that no longer exists", () =>
    Effect.gen(function* () {
      const { ingest, follows } = yield* makeHarness({
        script: { root: { events: ExecutionFixtures.rootEvents, status: "completed" } },
        turnStatus: "queued",
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: Fixtures.Turn.TurnId.make("absent") })
      yield* settle(ingest)

      expect(follows).toHaveLength(0)
    }),
  )
})
