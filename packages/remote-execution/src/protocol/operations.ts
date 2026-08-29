import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import { Deferred, Effect, Fiber, FiberSet, Function, Option, Ref, Schema, Semaphore, type Scope } from "effect"
import { terminalOutcome, type OutputChunk } from "./cells"
import {
  CellAttribution,
  CellLifecycleFrame,
  CellResponse,
  type AccessWire,
  type ApiMessage,
  type CellRequest,
  type MachineOutcome,
  type MachineRequest,
} from "./messages"

export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  kind: Schema.Literals(["authorization", "execution", "fenced", "persistence", "transport", "workspace"]),
  message: Schema.String,
}) {}

export const OperationReceipt = Schema.Struct({
  operationKey: Schema.String.check(Schema.isMinLength(1)),
  frames: Schema.NonEmptyArray(CellLifecycleFrame),
})
export type OperationReceipt = typeof OperationReceipt.Type

export type ReceiptMap = Map<string, ReadonlyArray<CellLifecycleFrame>>

export type Command = Extract<
  ApiMessage,
  {
    readonly _tag:
      | "CellCancel"
      | "CellExecute"
      | "CellReplay"
      | "CellTerminalReceipt"
      | "CellTerminalSuperseded"
      | "LocalCellReceipt"
      | "MachineExecute"
  }
>

export type Event =
  | { readonly _tag: "CellLifecycle"; readonly access: AccessWire; readonly frame: CellLifecycleFrame }
  | {
      readonly _tag: "CellResult"
      readonly access: AccessWire
      readonly operationKey: string
      readonly attempt: number
      readonly response: CellResponse
    }
  | {
      readonly _tag: "MachineResult"
      readonly access: AccessWire
      readonly operationKey: string
      readonly attempt: number
      readonly machineId: string
      readonly requestDigest: string
      readonly outcome: MachineOutcome
    }

type EventInput = Event extends infer E ? (E extends Event ? Omit<E, "access"> : never) : never

export interface PreparedCell {
  readonly secrets: ReadonlyArray<string>
  readonly execute: (output: (chunk: OutputChunk) => Effect.Effect<void>) => Effect.Effect<CellResponse, OperationError>
}

export interface Options {
  readonly access: Effect.Effect<AccessWire, OperationError>
  readonly receipts: {
    readonly current: Effect.Effect<ReceiptMap>
    readonly commit: (receipts: ReceiptMap) => Effect.Effect<void, OperationError>
  }
  readonly emit: (event: Event) => Effect.Effect<void, OperationError>
  readonly cell: {
    readonly prepare: (request: CellRequest) => Effect.Effect<PreparedCell, OperationError>
    readonly admit: (request: CellRequest) => Effect.Effect<void, OperationError>
    readonly cancel: (operationKey: string, attempt: number) => Effect.Effect<CellResponse, OperationError>
    readonly replayBindings: (access: AccessWire) => Effect.Effect<void, OperationError>
  }
  readonly machine: {
    readonly execute: (input: {
      readonly machineId: string
      readonly requestDigest: string
      readonly request: MachineRequest
    }) => Effect.Effect<MachineOutcome, OperationError>
  }
}

export interface Interface {
  readonly dispatch: (command: Command) => Effect.Effect<void, OperationError>
  readonly receipts: Effect.Effect<ReceiptMap>
  readonly terminalizeOpen: (
    response: CellResponse,
  ) => Effect.Effect<
    ReadonlyArray<{
      readonly operationKey: string
      readonly outcome: "completed" | "failed" | "cancelled" | "unknown"
    }>,
    OperationError
  >
}

interface ActiveOperation {
  readonly parent?: string
  readonly fiber: Fiber.Fiber<void, OperationError>
}

const OutputLimit = 16
const OutputTextLimit = 16_384

export const executionKey: {
  (operationKey: string, attempt: number): string
  (attempt: number): (operationKey: string) => string
} = Function.dual(2, (operationKey: string, attempt: number) => `${operationKey}\u0000${attempt}`)
const machineExecutionKey = (operationKey: string, attempt: number, machineId: string) =>
  `${executionKey(operationKey, attempt)}\u0000${machineId}`

const sameFence = (left: AccessWire["fence"], right: AccessWire["fence"]) =>
  left.target === right.target &&
  left.assignmentId === right.assignmentId &&
  left.assignmentGeneration === right.assignmentGeneration &&
  left.instanceId === right.instanceId &&
  left.executorId === right.executorId &&
  left.processIncarnation === right.processIncarnation

const sameAccess = (left: AccessWire, right: AccessWire) =>
  left.version === right.version &&
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  sameFence(left.fence, right.fence)

const attribution = (request: CellRequest): CellAttribution => ({
  operationKey: request.operationKey,
  workspaceId: request.workspaceId,
  sessionId: request.sessionId,
  threadId: request.threadId,
  turnId: request.turnId,
  runId: request.runId,
  rootRunId: request.rootRunId,
  toolCallId: request.toolCallId,
  attempt: request.attempt,
})

const sameAttribution = (left: CellAttribution, right: CellAttribution) =>
  left.operationKey === right.operationKey &&
  left.workspaceId === right.workspaceId &&
  left.sessionId === right.sessionId &&
  left.threadId === right.threadId &&
  left.turnId === right.turnId &&
  left.runId === right.runId &&
  left.rootRunId === right.rootRunId &&
  left.toolCallId === right.toolCallId &&
  left.attempt === right.attempt

const accepted = (frames: ReadonlyArray<CellLifecycleFrame>) =>
  frames.find((frame): frame is Extract<CellLifecycleFrame, { readonly _tag: "Accepted" }> => frame._tag === "Accepted")

const terminal = (frames: ReadonlyArray<CellLifecycleFrame>) =>
  frames.find((frame): frame is Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }> => frame._tag === "Terminal")

const redactText = (value: string, secrets: ReadonlyArray<string>) =>
  secrets.reduce((text, secret) => (secret.length === 0 ? text : text.split(secret).join("REDACTED")), value)

const redactOutput = (value: string, secrets: ReadonlyArray<string> = []) => {
  const text = redactText(value, secrets)
    .replace(/(token|password|secret|authorization)["']?\s*[:=]\s*["'][^"']+/gi, "$1=REDACTED")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "REDACTED")
  return { text: text.slice(0, OutputTextLimit), truncated: text.length > OutputTextLimit }
}

const redactResponse = (response: CellResponse, secrets: ReadonlyArray<string>): CellResponse => {
  if (secrets.length === 0) return response
  const encoded = Schema.encodeSync(Schema.fromJsonString(CellResponse))(response)
  return Schema.decodeSync(Schema.fromJsonString(CellResponse))(redactText(encoded, secrets))
}

const cellFailure = (error: OperationError): CellResponse => ({
  _tag: "DomainFailure",
  failure: { kind: error.kind, message: error.message },
})

const executionFailure: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "execution", message: "Cell execution failed" },
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
              const output = redactOutput(chunk.text, prepared.secrets)
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
