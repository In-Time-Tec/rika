import "./cells-recovery.fixture"
import { describe, expect, it } from "@effect/vitest"
import { Context, Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { Cells, layer, type State } from "../../src/protocol/cells"
import { CellRequest } from "../../src/protocol/messages"

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
    deadlineAt: "2999-01-01T00:00:00.000Z",
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

  it.effect("admits and executes after an earlier cancellation found no durable operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const state = stored()
        const calls = yield* Ref.make(0)
        const context = yield* Layer.build(
          layer({
            workspaceId: "workspace-1",
            ...state,
            execute: () =>
              Ref.updateAndGet(calls, (value) => value + 1).pipe(
                Effect.map((value) => ({ _tag: "Success" as const, result: value })),
              ),
          }),
        )
        const service = Context.get(context, Cells)
        const cell = request("operation-cancel-before-admit")
        const absent = yield* Effect.flip(service.cancel(cell.operationKey, cell.attempt))
        expect(absent.kind).toBe("fenced")

        expect(yield* service.execute(cell)).toEqual({ _tag: "Success", result: 1 })
        expect(yield* Ref.get(calls)).toBe(1)
        expect(state.values.get("operation-cancel-before-admit\u00000")).toEqual({
          _tag: "Completed",
          attempt: 0,
          response: { _tag: "Success", result: 1 },
        })
      }),
    ),
  )

  it.effect("retries admission after a concurrent cancellation reads absent state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstReadStarted = yield* Deferred.make<void>()
        const releaseFirstRead = yield* Deferred.make<void>()
        const reads = yield* Ref.make(0)
        const state = stored()
        const context = yield* Layer.build(
          layer({
            workspaceId: "workspace-1",
            read: (operationKey) =>
              Ref.updateAndGet(reads, (value) => value + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Deferred.succeed(firstReadStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseFirstRead)),
                        Effect.as<State | undefined>(undefined),
                      )
                    : state.read(operationKey),
                ),
              ),
            write: state.write,
            execute: () => Effect.succeed({ _tag: "Success", result: "executed" }),
          }),
        )
        const service = Context.get(context, Cells)
        const cell = request("operation-concurrent-absent")
        const cancelling = yield* Effect.forkChild(Effect.result(service.cancel(cell.operationKey, cell.attempt)), {
          startImmediately: true,
        })
        yield* Deferred.await(firstReadStarted)
        const executing = yield* Effect.forkChild(service.execute(cell), { startImmediately: true })
        yield* Deferred.succeed(releaseFirstRead, undefined)

        expect((yield* Fiber.join(cancelling))._tag).toBe("Failure")
        expect(yield* Fiber.join(executing)).toEqual({ _tag: "Success", result: "executed" })
        expect(yield* Ref.get(reads)).toBe(2)
      }),
    ),
  )

  it.effect("retries initialization after the first reader is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstReadStarted = yield* Deferred.make<void>()
        const reads = yield* Ref.make(0)
        const state = stored()
        const context = yield* Layer.build(
          layer({
            workspaceId: "workspace-1",
            read: (operationKey) =>
              Ref.updateAndGet(reads, (value) => value + 1).pipe(
                Effect.flatMap((count) =>
                  count === 1
                    ? Deferred.succeed(firstReadStarted, undefined).pipe(Effect.andThen(Effect.never))
                    : state.read(operationKey),
                ),
              ),
            write: state.write,
            execute: () => Effect.succeed({ _tag: "Success", result: "retried" }),
          }),
        )
        const service = Context.get(context, Cells)
        const cell = request("operation-interrupted-initialization")
        const interrupted = yield* Effect.forkChild(service.admit(cell), { startImmediately: true })
        yield* Deferred.await(firstReadStarted)
        yield* Fiber.interrupt(interrupted)

        expect(yield* service.execute(cell)).toEqual({ _tag: "Success", result: "retried" })
        expect(yield* Ref.get(reads)).toBe(2)
      }),
    ),
  )

  it.effect("does not let failed or interrupted higher attempts fence active lower authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const higherReadStarted = yield* Deferred.make<void>()
        const state = stored()
        const context = yield* Layer.build(
          layer({
            workspaceId: "workspace-1",
            read: (operationKey) =>
              operationKey === "operation-attempt-fence\u00002"
                ? Deferred.succeed(higherReadStarted, undefined).pipe(Effect.andThen(Effect.never))
                : state.read(operationKey),
            write: state.write,
            execute: () => Effect.die("cancelled lower attempt executed"),
          }),
        )
        const service = Context.get(context, Cells)
        const lower = request("operation-attempt-fence", 0)
        yield* service.admit(lower)
        expect((yield* Effect.result(service.cancel(lower.operationKey, 1)))._tag).toBe("Failure")
        const interruptedHigher = yield* Effect.forkChild(service.admit(request(lower.operationKey, 2)), {
          startImmediately: true,
        })
        yield* Deferred.await(higherReadStarted)
        yield* Fiber.interrupt(interruptedHigher)

        const response = yield* service.cancel(lower.operationKey, lower.attempt)
        expect(response).toEqual({
          _tag: "DomainFailure",
          failure: { kind: "cancelled", message: "Cell operation cancelled" },
        })
        expect(state.values.get("operation-attempt-fence\u00000")).toEqual({
          _tag: "Completed",
          attempt: 0,
          response,
        })
        expect(state.values.has("operation-attempt-fence\u00001")).toBe(false)
        expect(state.values.has("operation-attempt-fence\u00002")).toBe(false)
      }),
    ),
  )

  it.effect("settles duplicates when the first execution owner is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const executionStarted = yield* Deferred.make<void>()
        const state = stored()
        const context = yield* Layer.build(
          layer({
            workspaceId: "workspace-1",
            ...state,
            execute: () => Deferred.succeed(executionStarted, undefined).pipe(Effect.andThen(Effect.never)),
          }),
        )
        const service = Context.get(context, Cells)
        const cell = request("operation-owner-interrupted")
        const owner = yield* Effect.forkChild(Effect.exit(service.execute(cell)), { startImmediately: true })
        yield* Deferred.await(executionStarted)
        const duplicate = yield* Effect.forkChild(Effect.exit(service.execute(cell)), { startImmediately: true })
        yield* Effect.yieldNow
        yield* Fiber.interrupt(owner)

        expect((yield* Fiber.join(duplicate))._tag).toBe("Failure")
        expect((yield* Effect.exit(service.execute(cell)))._tag).toBe("Failure")
        expect(state.values.get("operation-owner-interrupted\u00000")).toEqual({ _tag: "Running", attempt: 0 })
      }),
    ),
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
