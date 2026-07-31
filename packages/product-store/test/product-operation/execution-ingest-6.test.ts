import { describe, expect, it } from "@effect/vitest"
import {
  Fixtures,
  Effect,
  Ref,
  ExecutionIngest,
  threadId,
  rootId,
  childId,
  checkpoint,
  event,
  started,
  rootEvents,
  childEvents,
  makeHarness,
  followsOf,
  settle,
} from "./execution-ingest-behavior-support"

describe("ExecutionIngest", () => {
  it.effect("writes only units changed by a resumed event regardless of transcript size", () =>
    Effect.gen(function* () {
      const history = Array.from({ length: 40 }, (_, index) =>
        event("root", `call-${index}`, index + 1, "tool.call.requested", {
          data: { tool_call_id: `call_${index}`, tool_name: "read", input: { path: `src/${index}.ts` } },
        }),
      )
      const result = event("root", "result", 41, "tool.result.received", {
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

      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)

      expect(writes).toEqual([{ upsert: ["tool:root:call_20"], remove: [] }])
      expect((yield* transcripts.get(rootId))?.units).toHaveLength(stored.units.length)
    }),
  )

  for (const outcome of ["failure", "stale"] as const)
    it.effect(`reports a typed ${outcome} checkpoint write to every waiter`, () =>
      Effect.gen(function* () {
        const failures: Array<ExecutionIngest.Failure> = []
        const events = [
          started("root"),
          event("root", "answer", 1, "model.output.completed", { text: "answer" }),
          event("root", "done", 2, "execution.completed"),
        ]
        const { ingest, transcripts } = yield* makeHarness({
          script: { root: { events, status: "completed" } },
          commitOutcome: outcome,
          onFailure: (failure) => failures.push(failure),
        })

        yield* ingest.ensure({ threadId, turnId: rootId })
        const consumedFailure = yield* Effect.flip(ingest.consumed(rootId))
        const settledFailure = yield* Effect.flip(ingest.settled(rootId))

        expect(failures).toEqual([consumedFailure])
        expect(settledFailure).toBe(consumedFailure)
        expect(consumedFailure.reason).toBe(outcome === "failure" ? "repository" : "checkpoint")
        expect(yield* transcripts.get(rootId)).toBeUndefined()
      }),
    )

  it.effect("clears a retained failure after a later authoritative retry succeeds", () =>
    Effect.gen(function* () {
      const commitFailures = yield* Ref.make(1)
      const events = [
        started("root"),
        event("root", "answer", 1, "model.output.completed", { text: "answer" }),
        event("root", "done", 2, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: { root: { events, status: "completed" } },
        commitFailures,
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      expect((yield* Effect.result(ingest.settled(rootId)))._tag).toBe("Failure")
      yield* ingest.ensure({ threadId, turnId: rootId })
      yield* ingest.consumed(rootId)
      yield* ingest.settled(rootId)

      expect((yield* transcripts.get(rootId))?.projectionVersion).toBe(ExecutionIngest.projectionVersion)
      expect((yield* Effect.result(ingest.consumed(rootId)))._tag).toBe("Success")
      expect((yield* Effect.result(ingest.settled(rootId)))._tag).toBe("Success")
    }),
  )

  it.effect("fails a terminal child whose durable parent tool never existed", () =>
    Effect.gen(function* () {
      const rootWithoutTool = [
        started("root"),
        event("root", "spawned", 1, "child_run.spawned", { data: { child_execution_id: childId } }),
        event("root", "done", 2, "execution.completed"),
      ]
      const terminalChild = [
        started(childId),
        event(childId, "answer", 1, "model.output.completed", { text: "detached answer" }),
        event(childId, "done", 2, "execution.completed"),
      ]
      const { ingest, transcripts } = yield* makeHarness({
        script: {
          root: { events: rootWithoutTool, status: "completed", children: [childId] },
          [childId]: { events: terminalChild, status: "completed" },
        },
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      const failure = yield* Effect.flip(ingest.settled(rootId))

      expect(failure.reason).toBe("attachment")
      expect(failure.executionId).toBe(childId)
      expect(yield* transcripts.get(rootId)).toBeUndefined()
    }),
  )

  it.effect("folds owner-delivered root events without following the root itself", () =>
    Effect.gen(function* () {
      const { ingest, transcripts, follows } = yield* makeHarness({
        script: { [childId]: { events: childEvents, status: "completed" } },
        turnStatus: "running",
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      for (const delivered of rootEvents) ingest.deliver(rootId, delivered)
      yield* settle(ingest)

      expect(followsOf(follows, "root")).toHaveLength(0)
      expect(followsOf(follows, childId)).toHaveLength(1)
      const stored = yield* transcripts.get(rootId)
      expect(checkpoint(stored, "root")).toEqual(
        expect.objectContaining({ cursor: "r3", sequence: 3, status: "completed" }),
      )
      expect(stored?.units.some((unit) => unit.parentId !== undefined && unit.turnId === childId)).toBe(true)
    }),
  )

  it.effect("ignores redelivered owner events instead of reporting a rejected cursor", () =>
    Effect.gen(function* () {
      const failures: Array<ExecutionIngest.Failure> = []
      const { ingest, transcripts } = yield* makeHarness({
        script: { [childId]: { events: childEvents, status: "completed" } },
        turnStatus: "running",
        onFailure: (failure) => failures.push(failure),
      })

      yield* ingest.ensure({ threadId, turnId: rootId })
      for (const delivered of rootEvents) ingest.deliver(rootId, delivered)
      for (const delivered of rootEvents) ingest.deliver(rootId, delivered)
      yield* settle(ingest)

      expect(failures).toHaveLength(0)
      expect(checkpoint(yield* transcripts.get(rootId), "root")).toEqual(
        expect.objectContaining({
          cursor: "r3",
          sequence: 3,
          status: "completed",
        }),
      )
    }),
  )
})
