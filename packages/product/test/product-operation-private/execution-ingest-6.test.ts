import { describe, expect, it } from "@effect/vitest"
import { makeHarness, followsOf, settle } from "./execution-ingest-behavior-support"

import { ExecutionFixtures } from "./execution-ingest-fixtures"

import { Fixtures } from "./execution-ingest-support"
import * as ExecutionIngest from "../../src/execution/ingest/execution-ingest-service"
import { Effect, Ref } from "effect"

describe("ExecutionIngest", () => {
  it.effect("writes only units changed by a resumed ExecutionFixtures.event regardless of transcript size", () =>
    Effect.gen(function* () {
      const history = Array.from({ length: 40 }, (_, index) =>
        ExecutionFixtures.event("root", `call-${index}`, index + 1, "tool.call.requested", {
          data: { tool_call_id: `call_${index}`, tool_name: "read", input: { path: `src/${index}.ts` } },
        }),
      )
      const result = ExecutionFixtures.event("root", "result", 41, "tool.result.received", {
        data: { tool_call_id: "call_20", output: "updated result" },
      })
      const stored = Fixtures.TranscriptProjection.Projection.project("root", "delegate", history)
      const { ingest, transcripts, writes } = yield* makeHarness({
        script: { root: { events: history.concat(result), status: "running" } },
        turnStatus: "running",
        stored,
        consumed: { root: { cursor: "call-39", sequence: 40 } },
        storedProjectionVersion: ExecutionIngest.projectionVersion,
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* ingest.consumed(ExecutionFixtures.rootId)

      expect(writes).toEqual([{ upsert: ["tool:root:call_20"], remove: [] }])
      expect((yield* transcripts.get(ExecutionFixtures.rootId))?.units).toHaveLength(stored.units.length)
    }),
  )

  for (const outcome of ["failure", "stale"] as const)
    it.effect(`reports a typed ${outcome} ExecutionFixtures.checkpoint write to every waiter`, () =>
      Effect.gen(function* () {
        const failures: Array<ExecutionIngest.Failure> = []
        const events = [
          ExecutionFixtures.started("root"),
          ExecutionFixtures.event("root", "answer", 1, "model.output.completed", { text: "answer" }),
          ExecutionFixtures.event("root", "done", 2, "execution.completed"),
        ]
        const { ingest, transcripts } = yield* makeHarness({
          script: { root: { events, status: "completed" } },
          commitOutcome: outcome,
          onFailure: (failure) => failures.push(failure),
        })

        yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
        const consumedFailure = yield* Effect.flip(ingest.consumed(ExecutionFixtures.rootId))
        const settledFailure = yield* Effect.flip(ingest.settled(ExecutionFixtures.rootId))

        expect(failures).toEqual([consumedFailure])
        expect(settledFailure).toBe(consumedFailure)
        expect(consumedFailure.reason).toBe(outcome === "failure" ? "repository" : "checkpoint")
        expect(yield* transcripts.get(ExecutionFixtures.rootId)).toBeUndefined()
      }),
    )

  it.effect("clears a retained failure after a later authoritative retry succeeds", () =>
    Effect.gen(function* () {
      const commitFailures = yield* Ref.make(1)
      const events = [
        ExecutionFixtures.started("root"),
        ExecutionFixtures.event("root", "answer", 1, "model.output.completed", { text: "answer" }),
        ExecutionFixtures.event("root", "done", 2, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: { root: { events, status: "completed" } },
        commitFailures,
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      expect((yield* Effect.result(ingest.settled(ExecutionFixtures.rootId)))._tag).toBe("Failure")
      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      yield* ingest.consumed(ExecutionFixtures.rootId)
      yield* ingest.settled(ExecutionFixtures.rootId)

      expect((yield* transcripts.get(ExecutionFixtures.rootId))?.projectionVersion).toBe(
        ExecutionIngest.projectionVersion,
      )
      expect((yield* Effect.result(ingest.consumed(ExecutionFixtures.rootId)))._tag).toBe("Success")
      expect((yield* Effect.result(ingest.settled(ExecutionFixtures.rootId)))._tag).toBe("Success")
    }),
  )

  it.effect("fails a terminal child whose durable parent tool never existed", () =>
    Effect.gen(function* () {
      const rootWithoutTool = [
        ExecutionFixtures.started("root"),
        ExecutionFixtures.event("root", "spawned", 1, "child_run.spawned", {
          data: { child_execution_id: ExecutionFixtures.childId },
        }),
        ExecutionFixtures.event("root", "done", 2, "execution.completed"),
      ]
      const terminalChild = [
        ExecutionFixtures.started(ExecutionFixtures.childId),
        ExecutionFixtures.event(ExecutionFixtures.childId, "answer", 1, "model.output.completed", {
          text: "detached answer",
        }),
        ExecutionFixtures.event(ExecutionFixtures.childId, "done", 2, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: rootWithoutTool, status: "completed", children: [ExecutionFixtures.childId] },
          [ExecutionFixtures.childId]: { events: terminalChild, status: "completed" },
        },
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      const failure = yield* Effect.flip(ingest.settled(ExecutionFixtures.rootId))

      expect(failure.reason).toBe("attachment")
      expect(failure.executionId).toBe(ExecutionFixtures.childId)
      expect(yield* transcripts.get(ExecutionFixtures.rootId)).toBeUndefined()
    }),
  )

  it.effect("folds owner-delivered root events without following the root itself", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, follows } = yield* makeHarness({
        script: { [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" } },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      for (const delivered of ExecutionFixtures.rootEvents) ingest.deliver(ExecutionFixtures.rootId, delivered)
      yield* settle(ingest)

      expect(followsOf(follows, "root")).toHaveLength(0)
      expect(followsOf(follows, ExecutionFixtures.childId)).toHaveLength(1)
      const stored = yield* transcripts.get(ExecutionFixtures.rootId)
      expect(ExecutionFixtures.checkpoint(stored, "root")).toEqual(
        expect.objectContaining({ cursor: "r3", sequence: 3, status: "completed" }),
      )
      expect(
        stored?.units.some((unit) => unit.parentId !== undefined && unit.turnId === ExecutionFixtures.childId),
      ).toBe(true)
    }),
  )

  it.effect("ignores redelivered owner events instead of reporting a rejected cursor", () =>
    Effect.gen(function* () {
      const failures: Array<ExecutionIngest.Failure> = []
      const { ingest, transcripts } = yield* makeHarness({
        script: { [ExecutionFixtures.childId]: { events: ExecutionFixtures.childEvents, status: "completed" } },
        turnStatus: "running",
        onFailure: (failure) => failures.push(failure),
      })

      yield* ingest.ensure({ threadId: ExecutionFixtures.threadId, turnId: ExecutionFixtures.rootId })
      for (const delivered of ExecutionFixtures.rootEvents) ingest.deliver(ExecutionFixtures.rootId, delivered)
      for (const delivered of ExecutionFixtures.rootEvents) ingest.deliver(ExecutionFixtures.rootId, delivered)
      yield* settle(ingest)

      expect(failures).toHaveLength(0)
      expect(ExecutionFixtures.checkpoint(yield* transcripts.get(ExecutionFixtures.rootId), "root")).toEqual(
        expect.objectContaining({
          cursor: "r3",
          sequence: 3,
          status: "completed",
        }),
      )
    }),
  )
})
