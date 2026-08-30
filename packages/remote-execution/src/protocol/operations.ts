import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import { Deferred, Effect, Fiber, FiberSet, Option, Ref, Semaphore, type Scope } from "effect"
import { terminalOutcome } from "./cells"
import {
  OperationError,
  OutputLimit,
  accepted,
  attribution,
  cellFailure,
  executionFailure,
  executionKey,
  machineExecutionKey,
  OutputRedaction,
  redactResponse,
  sameAccess,
  sameAttribution,
  terminal,
  type Command,
  type Event,
  type Interface,
  type Options,
} from "./operation-codec"
import type { AccessWire, CellLifecycleFrame, CellRequest } from "./messages"

export * from "./operation-codec"

type EventInput = Event extends infer E ? (E extends Event ? Omit<E, "access"> : never) : never

interface ActiveOperation {
  readonly parent?: string
  readonly fiber: Fiber.Fiber<void, OperationError>
}

export const make = (options: Options): Effect.Effect<Interface, never, Scope.Scope> =>
  Effect.gen(function* () {
    const lifecycle = yield* Semaphore.make(1)
    const activeAccess = yield* Semaphore.make(1)
    const active = yield* Ref.make(new Map<string, ActiveOperation>())
    const workers = yield* FiberSet.make<void, OperationError>()

    const requireAccess = Effect.fn("Operations.requireAccess")(function* (provided: AccessWire, message: string) {
      const current = yield* options.access
      if (!sameAccess(current, provided)) return yield* OperationError.make({ kind: "fenced", message })
      return current
    })

    const emit = (event: EventInput) =>
      options.access.pipe(
        Effect.flatMap((access) => {
          if (event._tag === "CellLifecycle") return options.emit({ ...event, access })
          if (event._tag === "CellResult") return options.emit({ ...event, access })
          return options.emit({ ...event, access })
        }),
      )

    const replayFrames = (frames: ReadonlyArray<CellLifecycleFrame>, afterCursor = 0) =>
      Effect.forEach(
        frames.filter((frame) => frame.cursor > afterCursor),
        (frame) => emit({ _tag: "CellLifecycle", frame }),
        { discard: true },
      )

    const append = (
      key: string,
      create: (frames: ReadonlyArray<CellLifecycleFrame>) => CellLifecycleFrame | undefined,
    ) =>
      lifecycle.withPermits(1)(
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const current = yield* options.receipts.current
            const frames = current.get(key) ?? []
            if (terminal(frames) !== undefined) return false
            const frame = create(frames)
            if (frame === undefined || frame.cursor !== frames.length + 1) return false
            const next = new Map(current).set(key, [...frames, frame])
            yield* options.receipts.commit(next)
            yield* restore(emit({ _tag: "CellLifecycle", frame }))
            return true
          }),
        ),
      )

    const ensureAccepted = Effect.fn("Operations.ensureAccepted")(function* (request: CellRequest) {
      const identity = attribution(request)
      const key = executionKey(request.operationKey, request.attempt)
      yield* append(key, (frames) =>
        frames.length === 0 ? { _tag: "Accepted", attribution: identity, cursor: 1 } : undefined,
      )
      const frames = (yield* options.receipts.current).get(key) ?? []
      const retained = accepted(frames)
      if (retained === undefined || !sameAttribution(retained.attribution, identity))
        return yield* OperationError.make({
          kind: "fenced",
          message: "Cell operation identity conflicts with retained execution",
        })
      return retained
    })

    const removeActive = (key: string) =>
      activeAccess.withPermits(1)(
        Ref.update(active, (current) => {
          const next = new Map(current)
          next.delete(key)
          return next
        }),
      )

    const start = (key: string, operation: Effect.Effect<void, OperationError>, parent?: string) =>
      activeAccess.withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(active)).has(key)) return false
          const gate = yield* Deferred.make<void>()
          const fiber = yield* FiberSet.run(
            workers,
            Deferred.await(gate).pipe(Effect.andThen(operation), Effect.ensuring(removeActive(key))),
          )
          const entry: ActiveOperation = parent === undefined ? { fiber } : { fiber, parent }
          yield* Ref.update(active, (current) => new Map(current).set(key, entry))
          yield* Deferred.succeed(gate, undefined)
          return true
        }),
      )

    const executeCell = Effect.fn("Operations.executeCell")(function* (request: CellRequest) {
      yield* requireAccess(request.access, "Cell request has a stale executor fence")
      const key = executionKey(request.operationKey, request.attempt)
      const identity = attribution(request)
      const known = (yield* options.receipts.current).get(key)
      const retainedAccepted = known === undefined ? undefined : accepted(known)
      if (retainedAccepted !== undefined && !sameAttribution(retainedAccepted.attribution, identity))
        return yield* OperationError.make({
          kind: "fenced",
          message: "Cell operation identity conflicts with retained execution",
        })
      const prepared = yield* options.cell.prepare(request)
      if (known !== undefined && (terminal(known) !== undefined || (yield* Ref.get(active)).has(key))) {
        yield* replayFrames(known)
        yield* options.access.pipe(Effect.flatMap(options.cell.replayBindings))
        return
      }
      const retained = yield* ensureAccepted(request)
      const admission = yield* Effect.result(options.cell.admit(request))
      if (admission._tag === "Failure") {
        const response = cellFailure(admission.failure)
        yield* append(key, (frames) => ({
          _tag: "Terminal",
          attribution: retained.attribution,
          cursor: frames.length + 1,
          outcome: terminalOutcome(response),
          response,
        }))
        return
      }
      yield* append(key, (frames) =>
        frames.some((frame) => frame._tag === "Started")
          ? undefined
          : { _tag: "Started", attribution: retained.attribution, cursor: frames.length + 1 },
      )
      const operation = Effect.gen(function* () {
        const response = yield* Effect.exit(
          prepared.execute((chunk) =>
            append(key, (frames) => {
              if (frames.filter((frame) => frame._tag === "Output").length >= OutputLimit) return undefined
              const output = OutputRedaction.apply(chunk.text, prepared.secrets)
              return {
                _tag: "Output",
                attribution: retained.attribution,
                cursor: frames.length + 1,
                stream: chunk.stream,
                text: output.text,
                redacted: true,
                truncated: output.truncated,
              }
            }).pipe(Effect.ignore),
          ),
        )
        const completed = yield* Exit.match(response, {
          onFailure: (cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.succeed(
                  Option.match(Cause.findErrorOption(cause), {
                    onNone: () => executionFailure,
                    onSome: cellFailure,
                  }),
                ),
          onSuccess: (value) => Effect.succeed(redactResponse(value, prepared.secrets)),
        })
        yield* append(key, (frames) => ({
          _tag: "Terminal",
          attribution: retained.attribution,
          cursor: frames.length + 1,
          outcome: terminalOutcome(completed),
          response: completed,
        }))
      })
      yield* start(key, operation)
    })

    const cancelCell = Effect.fn("Operations.cancelCell")(function* (
      command: Extract<Command, { readonly _tag: "CellCancel" }>,
    ) {
      yield* requireAccess(command.access, "Cell cancellation has a stale executor fence")
      const key = executionKey(command.operationKey, command.attempt)
      const frames = (yield* options.receipts.current).get(key)
      const retained = frames === undefined ? undefined : accepted(frames)
      if (retained === undefined || retained.attribution.attempt !== command.attempt)
        return yield* OperationError.make({ kind: "fenced", message: "Cell cancellation has a stale attempt" })
      const response = yield* options.cell.cancel(command.operationKey, command.attempt)
      const running = yield* Ref.get(active)
      const parent = running.get(key)
      if (parent !== undefined) yield* Fiber.interrupt(parent.fiber)
      const children = [...running.values()].filter((entry) => entry.parent === key)
      yield* Effect.forEach(children, (entry) => Fiber.interrupt(entry.fiber), { discard: true })
      const appended = yield* append(key, (current) => ({
        _tag: "Terminal",
        attribution: retained.attribution,
        cursor: current.length + 1,
        outcome: terminalOutcome(response),
        response,
      }))
      if (!appended && parent !== undefined) {
        const current = (yield* options.receipts.current).get(key) ?? []
        const completed = terminal(current)
        if (completed !== undefined) yield* emit({ _tag: "CellLifecycle", frame: completed })
      }
    })

    const replayCell = Effect.fn("Operations.replayCell")(function* (
      command: Extract<Command, { readonly _tag: "CellReplay" }>,
    ) {
      const access = yield* requireAccess(command.access, "Cell replay has a stale executor fence")
      const frames = (yield* options.receipts.current).get(executionKey(command.operationKey, command.attempt)) ?? []
      yield* replayFrames(frames, command.afterCursor)
      yield* options.cell.replayBindings(access)
    })

    const recoverCellResult = Effect.fn("Operations.recoverCellResult")(function* (
      command: Extract<Command, { readonly _tag: "CellTerminalReceipt" }>,
    ) {
      yield* requireAccess(command.access, "Cell terminal receipt has a stale executor fence")
      const frames = (yield* options.receipts.current).get(executionKey(command.operationKey, command.attempt)) ?? []
      const retained = terminal(frames)
      if (
        retained === undefined ||
        retained.cursor !== command.cursor ||
        retained.attribution.attempt !== command.attempt
      )
        return
      yield* emit({
        _tag: "CellResult",
        operationKey: command.operationKey,
        attempt: command.attempt,
        response: retained.response,
      })
    })

    const acknowledgeCell = Effect.fn("Operations.acknowledgeCell")(function* (
      command: Extract<Command, { readonly _tag: "LocalCellReceipt" }>,
    ) {
      yield* requireAccess(command.access, "Cell result receipt has a stale executor fence")
      const key = executionKey(command.operationKey, command.attempt)
      yield* lifecycle.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* options.receipts.current
            const frames = current.get(key)
            if (frames === undefined || accepted(frames)?.attribution.attempt !== command.attempt) return
            const next = new Map(current)
            next.delete(key)
            yield* options.receipts.commit(next)
          }),
        ),
      )
    })

    const executeMachine = Effect.fn("Operations.executeMachine")(function* (
      command: Extract<Command, { readonly _tag: "MachineExecute" }>,
    ) {
      yield* requireAccess(command.access, "Machine request has a stale executor fence")
      const parent = executionKey(command.operationKey, command.attempt)
      const parentFrames = (yield* options.receipts.current).get(parent)
      if (parentFrames === undefined || terminal(parentFrames) !== undefined) {
        yield* emit({
          _tag: "MachineResult",
          operationKey: command.operationKey,
          attempt: command.attempt,
          machineId: command.machineId,
          requestDigest: command.requestDigest,
          outcome: { _tag: "Fenced", message: "Parent Cell is no longer running" },
        })
        return
      }
      const key = machineExecutionKey(command.operationKey, command.attempt, command.machineId)
      yield* start(
        key,
        options.machine
          .execute({
            machineId: command.machineId,
            requestDigest: command.requestDigest,
            request: command.request,
          })
          .pipe(
            Effect.flatMap((outcome) =>
              emit({
                _tag: "MachineResult",
                operationKey: command.operationKey,
                attempt: command.attempt,
                machineId: command.machineId,
                requestDigest: command.requestDigest,
                outcome,
              }),
            ),
          ),
        parent,
      )
    })

    const dispatch: Interface["dispatch"] = Effect.fn("Operations.dispatch")(function* (command) {
      if (command._tag === "CellExecute") return yield* executeCell(command.request)
      if (command._tag === "CellCancel") return yield* cancelCell(command)
      if (command._tag === "CellReplay") return yield* replayCell(command)
      if (command._tag === "CellTerminalReceipt") return yield* recoverCellResult(command)
      if (command._tag === "LocalCellReceipt") return yield* acknowledgeCell(command)
      if (command._tag === "MachineExecute") return yield* executeMachine(command)
      yield* requireAccess(command.access, "Cell terminal supersession has a stale executor fence")
    })

    const terminalizeOpen: Interface["terminalizeOpen"] = Effect.fn("Operations.terminalizeOpen")(function* (response) {
      const running = [...(yield* Ref.get(active)).values()]
      yield* Effect.forEach(running, (entry) => Fiber.interrupt(entry.fiber), { discard: true })
      const current = yield* options.receipts.current
      for (const [key, frames] of current) {
        if (terminal(frames) !== undefined) continue
        const retained = accepted(frames)
        if (retained === undefined) continue
        yield* append(key, (known) => ({
          _tag: "Terminal",
          attribution: retained.attribution,
          cursor: known.length + 1,
          outcome: terminalOutcome(response),
          response,
        }))
      }
      const completed = yield* options.receipts.current
      return [
        ...new Map(
          [...completed.values()].flatMap((frames) => {
            const retained = terminal(frames)
            return retained === undefined
              ? []
              : [
                  [
                    retained.attribution.operationKey,
                    { operationKey: retained.attribution.operationKey, outcome: retained.outcome },
                  ],
                ]
          }),
        ).values(),
      ]
    })

    return { dispatch, receipts: options.receipts.current, terminalizeOpen } satisfies Interface
  })
