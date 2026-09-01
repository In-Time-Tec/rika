import { Clock, Deferred, Effect, Fiber, FiberSet, Ref, Semaphore, type Scope } from "effect"
import { runnerEvent, type RunnerAnnotations } from "./telemetry"
import { OperationError, type Command, type Event, type Interface, type Options } from "./operation-codec"

export * from "./operation-codec"

const sameAccess = (left: import("./messages").AccessWire, right: import("./messages").AccessWire) =>
  left.version === right.version &&
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  left.fence.target === right.fence.target &&
  left.fence.assignmentId === right.fence.assignmentId &&
  left.fence.assignmentGeneration === right.fence.assignmentGeneration &&
  left.fence.instanceId === right.fence.instanceId &&
  left.fence.executorId === right.fence.executorId &&
  left.fence.processIncarnation === right.fence.processIncarnation

const machineExecutionKey = (operationKey: string, attempt: number, machineId: string) =>
  `${operationKey}\u0000${attempt}\u0000${machineId}`

interface ActiveMachine {
  readonly command: Extract<Command, { readonly _tag: "MachineExecute" }>
  readonly fiber: Fiber.Fiber<void, OperationError>
}

export const make = (options: Options): Effect.Effect<Interface, never, Scope.Scope> =>
  Effect.gen(function* () {
    const activeAccess = yield* Semaphore.make(1)
    const active = yield* Ref.make(new Map<string, ActiveMachine>())
    const workers = yield* FiberSet.make<void, OperationError>()

    const requireAccess = Effect.fn("Operations.requireAccess")(function* (provided: Parameters<typeof sameAccess>[1]) {
      const current = yield* options.access
      if (!sameAccess(current, provided))
        return yield* OperationError.make({ kind: "fenced", message: "Machine request has a stale executor fence" })
      return current
    })

    const emit = (event: Omit<Event, "access">) =>
      Effect.flatMap(options.access, (access) => options.emit({ ...event, access }))

    const removeActive = (key: string) =>
      activeAccess.withPermits(1)(
        Ref.update(active, (current) => {
          const next = new Map(current)
          next.delete(key)
          return next
        }),
      )

    const start = (
      key: string,
      command: Extract<Command, { readonly _tag: "MachineExecute" }>,
      operation: Effect.Effect<void, OperationError>,
    ) =>
      activeAccess.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(active)).has(key)) return false
          const gate = yield* Deferred.make<void>()
          const fiber = yield* FiberSet.run(
            workers,
            Deferred.await(gate).pipe(Effect.andThen(operation), Effect.ensuring(removeActive(key))),
          )
          yield* Ref.update(active, (current) => new Map(current).set(key, { command, fiber }))
          yield* Deferred.succeed(gate, undefined)
          return true
        }),
      )

    const executeMachine = Effect.fn("Operations.executeMachine")(function* (
      command: Extract<Command, { readonly _tag: "MachineExecute" }>,
    ) {
      yield* requireAccess(command.access)
      const correlation: RunnerAnnotations = {
        "rika.operation.key": command.operationKey,
        "rika.operation.attempt": command.attempt,
        "rika.machine.id": command.machineId,
      }
      yield* runnerEvent("runner.machine.received", correlation)
      const key = machineExecutionKey(command.operationKey, command.attempt, command.machineId)
      yield* start(
        key,
        command,
        Effect.gen(function* () {
          const startedAt = yield* Clock.currentTimeMillis
          const outcome = yield* options.machine.execute({
            operationKey: command.operationKey,
            attempt: command.attempt,
            machineId: command.machineId,
            requestDigest: command.requestDigest,
            request: command.request,
          })
          yield* runnerEvent("runner.machine.result", {
            ...correlation,
            "rika.outcome": outcome._tag,
            "rika.duration.millis": Math.max(0, (yield* Clock.currentTimeMillis) - startedAt),
          })
          yield* emit({
            _tag: "MachineResult",
            operationKey: command.operationKey,
            attempt: command.attempt,
            machineId: command.machineId,
            requestDigest: command.requestDigest,
            outcome,
          })
        }),
      )
    })

    const cancelMachine = Effect.fn("Operations.cancelMachine")(function* (
      command: Extract<Command, { readonly _tag: "MachineCancel" }>,
      verifyAccess: boolean = true,
    ) {
      if (verifyAccess === true) yield* requireAccess(command.access)
      const correlation: RunnerAnnotations = {
        "rika.operation.key": command.operationKey,
        "rika.operation.attempt": command.attempt,
        "rika.machine.id": command.machineId,
      }
      yield* runnerEvent("runner.machine.cancel", correlation)
      const key = machineExecutionKey(command.operationKey, command.attempt, command.machineId)
      const running = (yield* Ref.get(active)).get(key)
      const admitted = running !== undefined && running.command.requestDigest === command.requestDigest
      if (admitted) yield* Fiber.interrupt(running.fiber)
      const outcome = yield* options.machine.cancel({
        machineId: command.machineId,
        requestDigest: command.requestDigest,
        admitted,
      })
      yield* runnerEvent("runner.machine.result", { ...correlation, "rika.outcome": outcome._tag })
      yield* emit({
        _tag: "MachineResult",
        operationKey: command.operationKey,
        attempt: command.attempt,
        machineId: command.machineId,
        requestDigest: command.requestDigest,
        outcome,
      })
      return outcome
    })

    const dispatch: Interface["dispatch"] = Effect.fn("Operations.dispatch")(function* (command) {
      yield* runnerEvent("runner.operation.dispatch", {
        "rika.runner.message": command._tag,
        "rika.operation.key": command.operationKey,
        "rika.operation.attempt": command.attempt,
      })
      if (command._tag === "MachineExecute") return yield* executeMachine(command)
      yield* cancelMachine(command)
    })

    const quiesce: Interface["quiesce"] = Effect.gen(function* () {
      const currentAccess = yield* options.access
      const running = [...(yield* Ref.get(active)).values()]
      yield* Effect.forEach(
        running,
        ({ command }) =>
          cancelMachine(
            {
              _tag: "MachineCancel",
              access: currentAccess,
              operationKey: command.operationKey,
              attempt: command.attempt,
              machineId: command.machineId,
              requestDigest: command.requestDigest,
            },
            false,
          ),
        { discard: true },
      )
    })

    return { dispatch, quiesce } satisfies Interface
  })
