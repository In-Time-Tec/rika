import { describe, expect, it } from "@effect/vitest"
import * as ExecutionBackend from "@rika/runtime/contract"
import { Context, Effect, Layer } from "effect"
import { lazyBackendLayer } from "../src/main"

const completedResult = (turnId: string): ExecutionBackend.Result => ({ turnId, status: "completed", events: [] })

const recordingBackend = (calls: Array<ReadonlyArray<unknown>>) => {
  const record = (...call: ReadonlyArray<unknown>) => Effect.sync(() => calls.push(call))
  return ExecutionBackend.Service.of({
    invokeChild: (input) => Effect.succeed({ ...input, type: "accepted" }),
    createFanOut: () => Effect.die("unused"),
    inspectFanOut: () => Effect.die("unused"),
    cancelFanOut: () => Effect.die("unused"),
    registerWorkflows: () => Effect.die("unused"),
    startWorkflow: () => Effect.die("unused"),
    inspectWorkflow: () => Effect.die("unused"),
    cancelWorkflow: () => Effect.die("unused"),
    start: (input) => Effect.succeed(completedResult(String(input.turnId))),
    replay: (turnId, afterCursor, reference) =>
      record("replay", turnId, afterCursor, reference).pipe(Effect.as(completedResult(turnId))),
    pageEvents: (turnId, direction, cursor, limit, reference) =>
      record("pageEvents", turnId, direction, cursor, limit, reference).pipe(Effect.as({ events: [], hasMore: false })),
    cancel: (turnId, cancelledAt, reference) =>
      record("cancel", turnId, cancelledAt, reference).pipe(Effect.as(completedResult(turnId))),
    inspect: (turnId, reference) =>
      record("inspect", turnId, reference).pipe(
        Effect.as({ turnId, status: "completed" as const, waits: [], pendingTools: [], children: [] }),
      ),
    steer: (turnId, text, createdAt, reference) =>
      record("steer", turnId, text, createdAt, reference).pipe(
        Effect.as({ steeringMessageId: `steering:${turnId}`, sequence: 0 }),
      ),
    listApprovals: (turnId, reference) => record("listApprovals", turnId, reference).pipe(Effect.as([])),
    resolveToolApproval: () => Effect.void,
    resolvePermission: () => Effect.void,
  })
}

describe("lazyBackendLayer", () => {
  it.effect("forwards execution references and pageEvents to the deferred backend", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<ReadonlyArray<unknown>> = []
        const context = yield* Layer.build(
          lazyBackendLayer(Layer.succeed(ExecutionBackend.Service, recordingBackend(calls))),
        )
        const backend = Context.get(context, ExecutionBackend.Service)
        const reference = ExecutionBackend.executionReference
        const childId = "child:execution%3Aturn-a:call_1"
        yield* backend.inspect(childId, reference)
        yield* backend.replay(childId, "cursor-1", reference)
        yield* backend.cancel(childId, 7, reference)
        yield* backend.steer(childId, "steer", 8, reference)
        yield* backend.listApprovals(childId, reference)
        expect(backend.pageEvents).toBeDefined()
        yield* backend.pageEvents!(childId, "forward", "cursor-2", 200, reference)
        expect(calls).toEqual([
          ["inspect", childId, reference],
          ["replay", childId, "cursor-1", reference],
          ["cancel", childId, 7, reference],
          ["steer", childId, "steer", 8, reference],
          ["listApprovals", childId, reference],
          ["pageEvents", childId, "forward", "cursor-2", 200, reference],
        ])
      }),
    ),
  )
})
