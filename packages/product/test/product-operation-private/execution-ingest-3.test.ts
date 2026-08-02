import { describe, expect, it } from "@effect/vitest"
import { makeHarness, followsOf, settle } from "./execution-ingest-behavior-support"

import { ExecutionFixtures } from "./execution-ingest-fixtures"

import { Fixtures } from "./execution-ingest-support"
import * as ExecutionIngest from "../../src/execution/ingest/execution-ingest-service"
import { Effect } from "effect"

describe("ExecutionIngest", () => {
  it.effect("follows each execution exactly once across repeated ensure calls", () =>
    Effect.gen(function* () {
      const { ingest, follows, refolds } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed" },
          [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" },
        },
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)
      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      expect(followsOf(follows, "root")).toHaveLength(1)
      expect(followsOf(follows, ExecutionFixtures.childId)).toHaveLength(1)
      expect(refolds).toHaveLength(0)
    }),
  )

  it.effect("records terminal consumed state that makes a later ensure a no-op", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, turns, follows } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed" },
          [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" },
        },
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)
      yield* turns.setStatus(ExecutionFixtures.rootId, "completed", "r3", 2)
      const stored = yield* transcripts.get(ExecutionFixtures.rootId)
      expect(
        stored?.executionCheckpoints.map(({ executionKey, cursor, sequence, status }) => ({
          executionKey,
          cursor,
          sequence,
          status,
        })),
      ).toEqual(
        expect.arrayContaining([
          { executionKey: "root", cursor: "r3", sequence: 3, status: "completed" },
          { executionKey: ExecutionFixtures.childId, cursor: "c3", sequence: 3, status: "completed" },
        ]),
      )
      expect(stored?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      const consumedFollows = follows.length

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)
      expect(follows).toHaveLength(consumedFollows)
    }),
  )

  it.effect("resumes a partially consumed execution from its stored cursor", () =>
    Effect.gen(function* () {
      const partial: ReadonlyArray<Fixtures.ExecutionBackend.Event> = ExecutionFixtures.rootEvents.slice(0, 3)
      const { ingest, transcripts, follows } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed", children: [ExecutionFixtures.childId] },
          [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" },
        },
        stored: Fixtures.TranscriptProjection.Projection.project("root", "delegate", partial),
        consumed: { root: { cursor: "r2", sequence: 2 } },
        storedProjectionVersion: ExecutionIngest.projectionVersion,
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)
      expect(ExecutionFixtures.checkpoint(yield* transcripts.get(ExecutionFixtures.rootId), "root")).toEqual(
        expect.objectContaining({
          cursor: "r3",
          sequence: 3,
          status: "completed",
        }),
      )
      expect(followsOf(follows, "root").map((followed) => followed.after)).toEqual(["r2"])
    }),
  )

  it.effect("resumes unfinished children without inspecting an already-terminal root", () =>
    Effect.gen(function* () {
      const partialChildEvents = ExecutionFixtures.childEvents.slice(0, 3)
      const root = Fixtures.TranscriptProjection.Projection.project("root", "delegate", ExecutionFixtures.rootEvents)
      const child = Fixtures.TranscriptProjection.Projection.project(ExecutionFixtures.childId, "", partialChildEvents)
      const stored = Fixtures.TranscriptNestedProjection.withNestedProjections(root, [
        { parentId: "root:call_1", projection: child },
      ])
      const { ingest, transcripts, follows, inspections } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed", children: [ExecutionFixtures.childId] },
          [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" },
        },
        turnStatus: "completed",
        stored,
        consumed: {
          root: { cursor: "r3", sequence: 3, status: "completed" },
          [ExecutionFixtures.childId]: { cursor: "c2", sequence: 2 },
        },
        executionStates: {
          root: Fixtures.TranscriptProjection.Projection.projectionState(root),
          [ExecutionFixtures.childId]: Fixtures.TranscriptProjection.Projection.projectionState(child),
        },
        storedProjectionVersion: ExecutionIngest.projectionVersion,
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      expect(inspections).toEqual([ExecutionFixtures.childId])
      expect(followsOf(follows, "root")).toEqual([])
      expect(followsOf(follows, ExecutionFixtures.childId).map((followed) => followed.after)).toEqual(["c2"])
      expect(
        ExecutionFixtures.checkpoint(yield* transcripts.get(ExecutionFixtures.rootId), ExecutionFixtures.childId)
          ?.status,
      ).toBe("completed")
    }),
  )

  it.effect("restores a child's fold state before resuming its durable suffix", () =>
    Effect.gen(function* () {
      const partialChildEvents: ReadonlyArray<Fixtures.ExecutionBackend.Event> = [
        ExecutionFixtures.started(ExecutionFixtures.childId),
        ExecutionFixtures.event(ExecutionFixtures.childId, "c1", 1, "model.input.prepared"),
        ExecutionFixtures.event(ExecutionFixtures.childId, "c2", 2, "model.output.completed", {
          text: "first child answer",
        }),
        ExecutionFixtures.event(ExecutionFixtures.childId, "c3", 3, "tool.call.requested", {
          data: { tool_call_id: "read", tool_name: "read", input: { path: "src/first.ts" } },
        }),
      ]
      const completeChildEvents = partialChildEvents.concat(
        ExecutionFixtures.event(ExecutionFixtures.childId, "c4", 4, "model.output.completed", {
          text: "second child answer",
        }),
        ExecutionFixtures.event(ExecutionFixtures.childId, "c5", 5, "execution.completed"),
      )
      const root = Fixtures.TranscriptProjection.Projection.project("root", "delegate", ExecutionFixtures.rootEvents)
      const child = {
        ...Fixtures.TranscriptProjection.Projection.project(ExecutionFixtures.childId, "", partialChildEvents),
        costUsd: 1.25,
        usageCursors: ["usage-cursor"],
        pricingVersion: Fixtures.TranscriptUsage.pricingVersion,
      }
      let expectedChild: Fixtures.TranscriptProjectionModel.Projection = child
      for (const suffix of completeChildEvents.slice(partialChildEvents.length))
        expectedChild = Fixtures.TranscriptProjection.Projection.applyEvent(expectedChild, suffix)
      const stored = Fixtures.TranscriptNestedProjection.withNestedProjections(root, [
        { parentId: "root:call_1", projection: child },
      ])
      const { ingest, transcripts, follows } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed", children: [ExecutionFixtures.childId] },
          [ExecutionFixtures.childId]: { events: completeChildEvents, status: "completed" },
        },
        stored,
        consumed: {
          root: { cursor: "r3", sequence: 3, status: "completed" },
          [ExecutionFixtures.childId]: { cursor: "c3", sequence: 3 },
        },
        executionStates: {
          root: Fixtures.TranscriptProjection.Projection.projectionState(root),
          [ExecutionFixtures.childId]: Fixtures.TranscriptProjection.Projection.projectionState(child),
        },
        storedProjectionVersion: ExecutionIngest.projectionVersion,
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      const resumed = yield* transcripts.get(ExecutionFixtures.rootId)
      expect(followsOf(follows, ExecutionFixtures.childId).map((followed) => followed.after)).toEqual(["c3"])
      expect(
        resumed?.units.flatMap((unit) =>
          unit.turnId === ExecutionFixtures.childId &&
          unit.content._tag === "Entry" &&
          unit.content.role === "assistant"
            ? [unit.content.text]
            : [],
        ),
      ).toEqual(["first child answer", "second child answer"])
      expect(ExecutionFixtures.checkpoint(resumed, ExecutionFixtures.childId)?.state).toEqual(
        Fixtures.TranscriptProjection.Projection.projectionState(expectedChild),
      )
      expect(ExecutionFixtures.checkpoint(resumed, ExecutionFixtures.childId)).toEqual(
        expect.objectContaining({ cursor: "c5", sequence: 5, status: "completed" }),
      )
    }),
  )

  it.effect("uses the child's projected completion when its backend status is failed", () =>
    Effect.gen(function* () {
      const recoveredChild = [
        ExecutionFixtures.started(ExecutionFixtures.childId),
        ExecutionFixtures.event(ExecutionFixtures.childId, "answer", 1, "model.output.completed", {
          text: "usable child answer",
        }),
        ExecutionFixtures.event(ExecutionFixtures.childId, "failed", 2, "execution.failed", {
          text: "late backend failure",
        }),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed", children: [ExecutionFixtures.childId] },
          [ExecutionFixtures.childId]: { events: recoveredChild, status: "failed" },
        },
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* settle(ingest)

      const stored = yield* transcripts.get(ExecutionFixtures.rootId)
      const parent = stored?.units.find(
        (unit) =>
          unit.parentId === undefined &&
          unit.content._tag === "Block" &&
          unit.content.block._tag === "ToolCall" &&
          unit.content.block.childId === ExecutionFixtures.childId,
      )
      expect(parent).toMatchObject({ content: { block: { status: "complete" } } })
      expect(ExecutionFixtures.checkpoint(stored, ExecutionFixtures.childId)?.status).toBe("failed")
      expect(
        stored?.units.find((unit) => unit.turnId === ExecutionFixtures.childId && unit.executionOutcome !== undefined)
          ?.executionOutcome,
      ).toEqual({ status: "complete" })
    }),
  )

  it.effect("fails when backend terminality has no durable projected outcome", () =>
    Effect.gen(function* () {
      const { ingest, projectionChanges, transcripts } = yield* makeHarness({
        script: {
          root: { events: ExecutionFixtures.rootEvents, status: "completed", children: [ExecutionFixtures.childId] },
          [ExecutionFixtures.childId]: {
            events: [
              ExecutionFixtures.event(ExecutionFixtures.childId, "answer", 1, "model.output.completed", {
                text: "unterminated answer",
              }),
            ],
            status: "completed",
          },
        },
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      const failure = yield* Effect.flip(ingest.settled(ExecutionFixtures.rootId))

      expect(failure.reason).toBe("backend")
      expect(failure.executionId).toBe(ExecutionFixtures.childId)
      expect(failure.message).toContain("projected durable terminal outcome")
      expect(yield* transcripts.get(ExecutionFixtures.rootId)).toBeUndefined()
      yield* Effect.yieldNow
      expect(projectionChanges.at(-1)).toMatchObject({
        _tag: "ProjectionFailed",
        failure,
      })
    }),
  )
})
