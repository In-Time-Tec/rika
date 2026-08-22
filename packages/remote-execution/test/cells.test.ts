import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import { Cells, layer, type State } from "../src/cells"
import { CellRequest } from "../src/protocol"

const fence = {
  target: "orb" as const,
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  instanceId: "sandbox-1",
  executorId: "executor-1",
  processIncarnation: "process-1",
}

const request = (operationKey: string, attempt?: number) =>
  CellRequest.make({
    access: { version: 1, fence, leaseEpoch: 1, sessionToken: "session-1" },
    operationKey,
    workspaceId: "workspace-1",
    sessionId: "session-1",
    threadId: "thread-1",
    turnId: "turn-1",
    runId: "run-1",
    rootRunId: "run-1",
    toolCallId: "call-1",
    code: "1 + 1",
    attempt: attempt ?? 0,
    replayPolicy: "pure",
    admittedAt: null,
    deadline: null,
    bindings: { digest: "a".repeat(64), descriptors: [] },
  })

const run = <A, E>(effect: Effect.Effect<A, E, Cells>, cells: Layer.Layer<Cells>) =>
  Effect.scoped(Effect.flatMap(Layer.build(cells), (context) => Effect.provide(effect, context)))

const stored = () => {
  const values = new Map<string, State>()
  return {
    values,
    read: (operationKey: string) => Effect.succeed(values.get(operationKey)),
    write: (operationKey: string, state: State) =>
      Effect.sync(() => values.set(operationKey, state)).pipe(Effect.asVoid),
  }
}

describe("Cells", () => {
  it.effect("deduplicates one attempt and executes an explicit higher attempt", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const cells = layer({
        workspaceId: "workspace-1",
        ...stored(),
        execute: () =>
          Ref.updateAndGet(calls, (value) => value + 1).pipe(
            Effect.map((value) => ({ _tag: "Success" as const, result: value })),
          ),
      })
      const responses = yield* run(
        Effect.gen(function* () {
          const service = yield* Cells
          return yield* Effect.all(
            [service.execute(request("operation-1")), service.execute(request("operation-1", 1))],
            {
              concurrency: "unbounded",
            },
          )
        }),
        cells,
      )
      expect(responses).toEqual([
        { _tag: "Success", result: 1 },
        { _tag: "Success", result: 2 },
      ])
      expect(yield* Ref.get(calls)).toBe(2)
    }),
  )

  it.effect("rejects a stale attempt and a request for another workspace", () =>
    Effect.gen(function* () {
      const cells = layer({
        workspaceId: "workspace-1",
        ...stored(),
        execute: () => Effect.succeed({ _tag: "Success" as const, result: null }),
      })
      const errors = yield* run(
        Effect.gen(function* () {
          const service = yield* Cells
          yield* service.execute(request("operation-1", 2))
          const stale = yield* Effect.flip(service.execute(request("operation-1", 1)))
          const workspace = yield* Effect.flip(
            service.execute({ ...request("operation-2"), workspaceId: "workspace-2" }),
          )
          return { stale, workspace }
        }),
        cells,
      )
      expect(errors.stale.kind).toBe("fenced")
      expect(errors.workspace.kind).toBe("workspace")
    }),
  )

  it.effect("returns a completed result after restart without executing again", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const state = stored()
      const options = {
        workspaceId: "workspace-1",
        ...state,
        execute: () =>
          Ref.updateAndGet(calls, (value) => value + 1).pipe(
            Effect.map((value) => ({ _tag: "Success" as const, result: value })),
          ),
      }
      const first = yield* run(
        Effect.flatMap(Cells, (cells) => cells.execute(request("operation-1"))),
        layer(options),
      )
      const replay = yield* run(
        Effect.flatMap(Cells, (cells) => cells.execute(request("operation-1"))),
        layer(options),
      )

      expect(first).toEqual({ _tag: "Success", result: 1 })
      expect(replay).toEqual(first)
      expect(yield* Ref.get(calls)).toBe(1)
    }),
  )

  it.effect("does not repeat an operation interrupted after its durable start", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)
      const state = stored()
      state.values.set("operation-1\u00000", { _tag: "Running", attempt: 0 })
      const response = yield* run(
        Effect.flatMap(Cells, (cells) => cells.execute(request("operation-1"))),
        layer({
          workspaceId: "workspace-1",
          ...state,
          execute: () =>
            Ref.update(calls, (value) => value + 1).pipe(Effect.as({ _tag: "Success" as const, result: null })),
        }),
      )

      expect(response).toEqual({
        _tag: "DomainFailure",
        failure: { kind: "unknown", message: "Cell operation outcome is unknown" },
      })
      expect(yield* Ref.get(calls)).toBe(0)
    }),
  )
})
