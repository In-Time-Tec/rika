import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Ref, Schema } from "effect"
import type { AccessWire, MachineOutcome, Target } from "../../src/protocol/messages"
import * as Operations from "../../src/protocol/operations"

type AdapterTarget = Target

const currentAccess = (target: AdapterTarget, leaseEpoch = 1): AccessWire => ({
  version: 1,
  fence: {
    target,
    assignmentId: "assignment-1",
    assignmentGeneration: 1,
    instanceId: "instance-1",
    executorId: "executor-1",
    processIncarnation: "process-1",
  },
  leaseEpoch,
  sessionToken: `session-${leaseEpoch}`,
})

class EventuallyTimeout extends Schema.TaggedError<EventuallyTimeout>()("EventuallyTimeout", {
  message: Schema.String,
}) {}

const eventually = <A>(effect: Effect.Effect<A | undefined>): Effect.Effect<A, EventuallyTimeout> =>
  Effect.flatMap(effect, (value) =>
    value === undefined ? Effect.yieldNow.pipe(Effect.andThen(eventually(effect))) : Effect.succeed(value),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => Effect.fail(EventuallyTimeout.make({ message: "timed out" })),
    }),
  )

const machineExecute = (access: AccessWire, operationKey = "operation-1", machineId = "machine-1") => ({
  _tag: "MachineExecute" as const,
  access,
  operationKey,
  attempt: 0,
  machineId,
  requestDigest: "a".repeat(64),
  request: { _tag: "NativeTool" as const, request: { _tag: "Read" as const, path: "missing.txt" } },
})

interface HarnessOptions {
  readonly execute?: Effect.Effect<MachineOutcome, Operations.OperationError>
  readonly observe?: Operations.Options["machine"]["observe"]
  readonly emit?: Operations.Options["emit"]
  readonly cancel?: (input: {
    readonly machineId: string
    readonly requestDigest: string
    readonly admitted: boolean
  }) => Effect.Effect<MachineOutcome, Operations.OperationError>
}

const makeHarness = (target: AdapterTarget, options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const access = yield* Ref.make(currentAccess(target))
    const emitted = yield* Ref.make<ReadonlyArray<Operations.Event>>([])
    const executeCount = yield* Ref.make(0)
    const cancelCount = yield* Ref.make(0)
    const baseMachine = {
      execute: () =>
        Ref.update(executeCount, (count) => count + 1).pipe(Effect.andThen(options.execute ?? Effect.never)),
      cancel: (input: Parameters<NonNullable<Operations.Options["machine"]["cancel"]>>[0]) =>
        Ref.update(cancelCount, (count) => count + 1).pipe(
          Effect.andThen(options.cancel?.(input) ?? Effect.succeed({ _tag: "Cancelled" as const })),
        ),
    }
    const machine: Operations.Options["machine"] =
      options.observe === undefined ? baseMachine : { ...baseMachine, observe: options.observe }
    const operations = yield* Operations.make({
      access: Ref.get(access),
      emit: (event) =>
        Ref.update(emitted, (events) => [...events, event]).pipe(Effect.andThen(options.emit?.(event) ?? Effect.void)),
      machine,
    })
    return { access, emitted, executeCount, cancelCount, operations }
  })

for (const target of ["runner", "orb"] as const) {
  describe(`${target} native machine operations`, () => {
    it.effect("emits a separately correlated terminal process observation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness(target, {
            execute: Effect.succeed({
              _tag: "Success",
              value: { _tag: "NativeTool", result: { text: "", truncated: false, running: true, processId: "7" } },
            }),
            observe: (processId) => Effect.succeed({ processId, exitCode: 4, elapsedMillis: 25, truncated: false }),
          })
          const execute = machineExecute(yield* Ref.get(harness.access))
          yield* harness.operations.dispatch(execute)
          const observation = yield* eventually(
            Ref.get(harness.emitted).pipe(
              Effect.map((events) => events.find((event) => event._tag === "ProcessObservation")),
            ),
          )
          expect(observation).toMatchObject({
            _tag: "ProcessObservation",
            operationKey: execute.operationKey,
            machineId: execute.machineId,
            observation: { processId: "7", exitCode: 4 },
          })
        }),
      ),
    )

    it.effect("starts observation after result send failure without suppressing result replay", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const observed = yield* Deferred.make<void>()
          let resultAttempts = 0
          const harness = yield* makeHarness(target, {
            execute: Effect.succeed({
              _tag: "Success",
              value: { _tag: "NativeTool", result: { text: "", truncated: false, running: true, processId: "8" } },
            }),
            observe: (processId) =>
              Deferred.succeed(observed, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.as({ processId, exitCode: 0, elapsedMillis: 30, truncated: false }),
              ),
            emit: (event) => {
              if (event._tag !== "MachineResult" || ++resultAttempts > 1) return Effect.void
              return Effect.fail(Operations.OperationError.make({ kind: "transport", message: "connection dropped" }))
            },
          })
          const execute = machineExecute(yield* Ref.get(harness.access))
          yield* harness.operations.dispatch(execute)
          yield* Deferred.await(observed)
          yield* Effect.yieldNow
          yield* harness.operations.dispatch(execute)
          yield* eventually(
            Ref.get(harness.emitted).pipe(
              Effect.map((events) =>
                events.filter((event) => event._tag === "MachineResult").length === 2 ? true : undefined,
              ),
            ),
          )
          expect(yield* Ref.get(harness.executeCount)).toBe(2)
        }),
      ),
    )

    it.effect("deduplicates execute and retains direct cancellation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const interrupted = yield* Deferred.make<void>()
          const harness = yield* makeHarness(target, {
            execute: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
          })
          const execute = machineExecute(yield* Ref.get(harness.access))
          yield* harness.operations.dispatch(execute)
          yield* eventually(
            Ref.get(harness.executeCount).pipe(Effect.map((count) => (count === 1 ? count : undefined))),
          )
          yield* harness.operations.dispatch(execute)
          expect(yield* Ref.get(harness.executeCount)).toBe(1)
          const cancel = {
            _tag: "MachineCancel" as const,
            access: execute.access,
            operationKey: execute.operationKey,
            attempt: execute.attempt,
            machineId: execute.machineId,
            requestDigest: execute.requestDigest,
          }
          yield* harness.operations.dispatch(cancel)
          yield* Deferred.await(interrupted)
          expect((yield* Ref.get(harness.emitted)).at(-1)).toMatchObject({
            _tag: "MachineResult",
            machineId: execute.machineId,
            outcome: { _tag: "Cancelled" },
          })
          yield* harness.operations.dispatch(cancel)
          expect(yield* Ref.get(harness.cancelCount)).toBe(2)
          expect((yield* Ref.get(harness.emitted)).at(-1)).toMatchObject({ outcome: { _tag: "Cancelled" } })
        }),
      ),
    )

    it.effect("does not interrupt the retained execute for a conflicting cancellation digest", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const interrupted = yield* Deferred.make<void>()
          const harness = yield* makeHarness(target, {
            execute: Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
            cancel: (input) =>
              Effect.succeed(
                input.requestDigest === "a".repeat(64)
                  ? { _tag: "Cancelled" as const }
                  : { _tag: "Fenced" as const, message: "request conflict" },
              ),
          })
          const execute = machineExecute(yield* Ref.get(harness.access))
          yield* harness.operations.dispatch(execute)
          yield* eventually(
            Ref.get(harness.executeCount).pipe(Effect.map((count) => (count === 1 ? count : undefined))),
          )
          yield* harness.operations.dispatch({
            _tag: "MachineCancel",
            access: execute.access,
            operationKey: execute.operationKey,
            attempt: execute.attempt,
            machineId: execute.machineId,
            requestDigest: "b".repeat(64),
          })
          expect(yield* Deferred.isDone(interrupted)).toBe(false)
          expect((yield* Ref.get(harness.emitted)).at(-1)).toMatchObject({ outcome: { _tag: "Fenced" } })
          yield* harness.operations.dispatch({
            _tag: "MachineCancel",
            access: execute.access,
            operationKey: execute.operationKey,
            attempt: execute.attempt,
            machineId: execute.machineId,
            requestDigest: execute.requestDigest,
          })
          yield* Deferred.await(interrupted)
        }),
      ),
    )

    it.effect("fences stale execute and cancellation access", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness(target)
          const stale = currentAccess(target, 2)
          const execute = machineExecute(stale)
          const executeExit = yield* Effect.exit(harness.operations.dispatch(execute))
          expect(executeExit._tag).toBe("Failure")
          const cancelExit = yield* Effect.exit(
            harness.operations.dispatch({
              _tag: "MachineCancel",
              access: stale,
              operationKey: execute.operationKey,
              attempt: execute.attempt,
              machineId: execute.machineId,
              requestDigest: execute.requestDigest,
            }),
          )
          expect(cancelExit._tag).toBe("Failure")
          expect(yield* Ref.get(harness.executeCount)).toBe(0)
          expect(yield* Ref.get(harness.cancelCount)).toBe(0)
        }),
      ),
    )

    it.effect("emits with renewed access and quiesces every active machine", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* Deferred.make<MachineOutcome>()
          const harness = yield* makeHarness(target, { execute: Deferred.await(first) })
          const original = yield* Ref.get(harness.access)
          const execute = machineExecute(original, "operation-renewed", "machine-renewed")
          yield* harness.operations.dispatch(execute)
          yield* eventually(
            Ref.get(harness.executeCount).pipe(Effect.map((count) => (count === 1 ? count : undefined))),
          )
          const renewed = currentAccess(target, 2)
          yield* Ref.set(harness.access, renewed)
          yield* Deferred.succeed(first, {
            _tag: "Success",
            value: { _tag: "NativeTool", result: { text: "done", truncated: false } },
          })
          const result = yield* eventually(
            Ref.get(harness.emitted).pipe(
              Effect.map((events) => events.find((event) => event.machineId === execute.machineId)),
            ),
          )
          expect(result.access).toEqual(renewed)

          const quiesced = yield* makeHarness(target)
          const active = machineExecute(yield* Ref.get(quiesced.access), "operation-quiesce", "machine-quiesce")
          yield* quiesced.operations.dispatch(active)
          yield* eventually(
            Ref.get(quiesced.executeCount).pipe(Effect.map((count) => (count === 1 ? count : undefined))),
          )
          yield* quiesced.operations.quiesce
          expect(yield* Ref.get(quiesced.cancelCount)).toBe(1)
          expect((yield* Ref.get(quiesced.emitted)).at(-1)).toMatchObject({
            machineId: "machine-quiesce",
            outcome: { _tag: "Cancelled" },
          })
        }),
      ),
    )
  })
}
