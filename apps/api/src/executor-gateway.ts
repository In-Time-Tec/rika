import type { ControllerError, Interface as Controller } from "@rika/e2b-executor/controller"
import type * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import type * as MachineBindings from "@rika/kernel/machine-bindings"
import { HostBindingRegistry } from "tenetkit/repl"
import {
  ApiMessage,
  CellLifecycleFrame as CellLifecycleFrameSchema,
  CellResponse as CellResponseSchema,
  ExecutorMessage,
  redactAccess,
  redactHeartbeat,
  redactHello,
  type AccessWire,
  type CellLifecycleFrame,
  type CellResponse,
  type Fence,
  type ExecutorMessage as ExecutorMessageValue,
  MachineRequest,
  type BindingManifest,
  type BindingOutcome,
  BindingRequest,
  type MachineOutcome,
  type PtyCreate,
  type PtyInput,
  type PtyReconnect,
  type PtyResize,
} from "@rika/remote-execution/protocol"
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Deferred,
  Effect,
  Encoding,
  Option,
  PubSub,
  Redacted,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import type { EnvironmentPhase } from "@rika/product/environment-policy"

export interface Socket {
  readonly send: (message: string) => unknown
  readonly close: (code?: number, reason?: string) => unknown
}

interface Session {
  readonly socket: Socket
  readonly access: AccessWire
  readonly leaseExpiresAt: number
}

export interface ExecutionResult {
  readonly access?: AccessWire
  readonly response: CellResponse
  readonly outcome: "completed" | "failed" | "cancelled" | "unknown"
}

export type PtyRequest =
  | { readonly _tag: "PtyCreate"; readonly request: PtyCreate }
  | { readonly _tag: "PtyInput"; readonly request: PtyInput }
  | { readonly _tag: "PtyResize"; readonly request: PtyResize }
  | { readonly _tag: "PtyDisconnect"; readonly ptyId: string }
  | { readonly _tag: "PtyReconnect"; readonly request: PtyReconnect }
  | { readonly _tag: "PtyTerminate"; readonly ptyId: string }

export type PtyEvent = Extract<
  ExecutorMessageValue,
  {
    readonly _tag: "PtyOpened" | "PtyOutput" | "PtyReplayGap" | "PtyDisconnected" | "PtyTerminated"
  }
>

interface Pending {
  readonly assignmentId: string
  readonly operationKey: string
  readonly attempt: number
  readonly request: ExecuteInput
  readonly socket: Socket
  readonly access: AccessWire
  readonly result: Deferred.Deferred<ExecutionResult, GatewayError>
  readonly waiters: number
  readonly bindings: BindingAuthority
  readonly bindingCalls: Ref.Ref<Map<string, BindingCall>>
  readonly nextMachineOrdinal: Ref.Ref<number>
}

interface BindingCall {
  readonly requestDigest: string
  readonly result: Deferred.Deferred<BindingOutcome>
}

interface MachineCall {
  readonly assignmentId: string
  readonly operationKey: string
  readonly attempt: number
  readonly machineId: string
  readonly requestDigest: string
  readonly request: MachineRequest
  readonly socket: Socket
  readonly access: AccessWire
  readonly result: Deferred.Deferred<MachineOutcome>
}

export interface BindingAuthority {
  readonly registry: HostBindingRegistry.Interface
  readonly context: Context.Context<ExecutorRuntime.CellServices>
  readonly manifest: BindingManifest
}

export class GatewayError extends Schema.TaggedError<GatewayError>()("ExecutorGatewayError", {
  kind: Schema.Literals(["disconnected", "fenced", "timeout", "transport"]),
  message: Schema.String,
}) {}

export interface ExecuteInput {
  readonly assignmentId: string
  readonly operationKey: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly threadId: string
  readonly turnId: string
  readonly runId: string
  readonly toolCallId: string
  readonly code: string
  readonly rootRunId: string
  readonly attempt: number
  readonly replayPolicy: "pure" | "provider-idempotent" | "never"
  readonly admittedAt: string | null
  readonly deadline: string | null
  readonly bindings: BindingAuthority
  readonly recoveryAttempt?: number
}

export interface Gateway {
  readonly receive: (socket: Socket, frame: unknown) => Effect.Effect<void>
  readonly disconnected: (socket: Socket) => Effect.Effect<void>
  readonly active: (socket: Socket) => Effect.Effect<boolean>
  readonly execute: (input: ExecuteInput) => Effect.Effect<ExecutionResult, GatewayError>
  readonly cancel: (assignmentId: string, operationKey: string) => Effect.Effect<void, GatewayError>
  readonly machine: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    request: MachineBindings.Request,
  ) => Effect.Effect<MachineBindings.Outcome, GatewayError>
  readonly sendPty: (assignmentId: string, request: PtyRequest) => Effect.Effect<void, GatewayError>
  readonly ptyEvents: (assignmentId: string) => Stream.Stream<PtyEvent>
}

export interface LifecycleStore {
  readonly append: (assignmentId: string, frame: CellLifecycleFrame) => Effect.Effect<void, GatewayError>
  readonly load: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
  ) => Effect.Effect<ReadonlyArray<CellLifecycleFrame>, GatewayError>
  readonly prepare: (input: ExecuteInput) => Effect.Effect<void, GatewayError>
  readonly inspect: (input: ExecuteInput) => Effect.Effect<
    {
      readonly state: "accepted" | "dispatched" | "completed" | "unknown"
      readonly started: boolean
      readonly response?: CellResponse
      readonly dispatchedGeneration?: number
      readonly dispatchedExecutorInstanceId?: string
      readonly dispatchedProcessIncarnation?: string
    },
    GatewayError
  >
  readonly dispatch: (input: ExecuteInput, access: AccessWire) => Effect.Effect<void, GatewayError>
  readonly reassign: (input: ExecuteInput) => Effect.Effect<void, GatewayError>
  readonly markUnknown: (input: ExecuteInput) => Effect.Effect<void, GatewayError>
}

export interface PhaseEnvironmentGrant {
  readonly digest: string
  readonly values: Readonly<Record<string, Redacted.Redacted<string>>>
  readonly redactedNames: ReadonlyArray<string>
}

export interface PhaseAuthority {
  readonly activate: <A, R>(
    access: AccessWire,
    phase: EnvironmentPhase,
    use: (grant: PhaseEnvironmentGrant) => Effect.Effect<A, GatewayError, R>,
  ) => Effect.Effect<A, GatewayError, R>
  readonly replace: (key: {
    readonly assignmentId: string
    readonly generation: number
  }) => Effect.Effect<void, GatewayError>
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutorMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ApiMessage))
const equivalentLifecycle = Schema.toEquivalence(CellLifecycleFrameSchema)
const equivalentResponse = Schema.toEquivalence(CellResponseSchema)
const key = (assignmentId: string, operationKey: string, attempt: number) =>
  `${assignmentId}\u0000${operationKey}\u0000${attempt}`
const machineKey = (assignmentId: string, operationKey: string, attempt: number, machineId: string) =>
  `${assignmentId}\u0000${operationKey}\u0000${attempt}\u0000${machineId}`
const encodeBindingRequest = Schema.encodeSync(Schema.fromJsonString(BindingRequest))
const encodeMachineRequest = Schema.encodeSync(Schema.fromJsonString(MachineRequest))

const sameAccess = (left: AccessWire, right: AccessWire) =>
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  left.fence.target === right.fence.target &&
  left.fence.assignmentId === right.fence.assignmentId &&
  left.fence.assignmentGeneration === right.fence.assignmentGeneration &&
  left.fence.instanceId === right.fence.instanceId &&
  left.fence.executorId === right.fence.executorId &&
  left.fence.processIncarnation === right.fence.processIncarnation

const sameExecutor = (left: AccessWire, right: AccessWire) =>
  left.sessionToken === right.sessionToken &&
  left.fence.target === right.fence.target &&
  left.fence.assignmentId === right.fence.assignmentId &&
  left.fence.assignmentGeneration === right.fence.assignmentGeneration &&
  left.fence.instanceId === right.fence.instanceId &&
  left.fence.executorId === right.fence.executorId &&
  left.fence.processIncarnation === right.fence.processIncarnation

const accessFailure = (error: ControllerError) =>
  GatewayError.make({
    kind: error.kind === "fenced" || error.kind === "lease-expired" ? "fenced" : "transport",
    message: error.message,
  })

const expired = () => GatewayError.make({ kind: "fenced", message: "Executor lease expired before work could be sent" })

const fenceOf = (message: ExecutorMessageValue): Fence | undefined => {
  switch (message._tag) {
    case "ExecutorHello":
      return message.hello.fence
    case "ExecutorReconnect":
      return message.access.fence
    case "ExecutorHeartbeat":
      return message.heartbeat.access.fence
    case "CheckpointStaged":
    case "CheckoutRequested":
    case "PtyOpened":
    case "PtyOutput":
    case "PtyReplayGap":
    case "PtyDisconnected":
    case "PtyTerminated":
    case "CellLifecycle":
    case "BindingInvoke":
    case "MachineResult":
      return message.access.fence
    case "CellResult":
      return message.access.fence
  }
}

const close = (socket: Socket, code: number, reason: string) => {
  socket.close(code, reason)
}

const failure = (socket: Socket, message: ExecutorMessageValue, error: ControllerError | GatewayError) => {
  const fence = fenceOf(message)
  if (fence !== undefined) socket.send(encode({ _tag: "Fenced", fence, message: error.message }))
  close(socket, 1008, error.kind)
}

export const makeGateway = Effect.fn("ExecutorGateway.make")(function* (
  controller: Controller,
  lifecycle: LifecycleStore,
  phases: PhaseAuthority,
) {
  const sessions = yield* Ref.make(new Map<string, Session>())
  const assignments = yield* Ref.make(new Map<Socket, string>())
  const pending = yield* Ref.make(new Map<string, Pending>())
  const machineCalls = yield* Ref.make(new Map<string, MachineCall>())
  const frames = yield* Ref.make(new Map<string, ReadonlyArray<CellLifecycleFrame>>())
  const terminals = yield* Ref.make(new Map<string, Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }>>())
  const admission = yield* Semaphore.make(1)
  const ptyFrames = yield* PubSub.sliding<PtyEvent>(256)
  const crypto = yield* Crypto.Crypto
  const digest = Effect.fn("ExecutorGateway.digest")(function* (value: string) {
    return Encoding.encodeHex(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(value))
        .pipe(
          Effect.mapError(() => GatewayError.make({ kind: "transport", message: "Could not identify RPC request" })),
        ),
    )
  })

  const grant = (
    session: Session,
    phase: EnvironmentPhase,
    operationKey: string | null,
  ): Effect.Effect<void, GatewayError> =>
    phases.activate(session.access, phase, (environment) =>
      Effect.try({
        try: () => {
          session.socket.send(
            encode({
              _tag: "PhaseEnvironmentGranted",
              phase,
              digest: environment.digest,
              operationKey,
              values: Object.fromEntries(
                Object.entries(environment.values).map(([name, value]) => [name, Redacted.value(value)]),
              ),
              redactedNames: environment.redactedNames,
            }),
          )
        },
        catch: () => GatewayError.make({ kind: "transport", message: "Could not authorize executor phase" }),
      }),
    )

  const hydrate = Effect.fn("ExecutorGateway.hydrate")(function* (input: ExecuteInput) {
    const retained = yield* lifecycle.load(input.assignmentId, input.operationKey, input.attempt)
    let outputCount = 0
    let terminal: Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }> | undefined
    for (const [index, frame] of retained.entries()) {
      const identity = frame.attribution
      if (
        frame.cursor !== index + 1 ||
        identity.operationKey !== input.operationKey ||
        identity.workspaceId !== input.workspaceId ||
        identity.sessionId !== input.sessionId ||
        identity.threadId !== input.threadId ||
        identity.turnId !== input.turnId ||
        identity.runId !== input.runId ||
        identity.rootRunId !== input.rootRunId ||
        identity.toolCallId !== input.toolCallId ||
        identity.attempt !== input.attempt ||
        (index === 0 && frame._tag !== "Accepted") ||
        (index === 1 && frame._tag !== "Started") ||
        (index > 1 && frame._tag !== "Output" && frame._tag !== "Terminal") ||
        terminal !== undefined
      )
        return yield* GatewayError.make({ kind: "transport", message: "Persisted executor lifecycle is invalid" })
      if (frame._tag === "Output") {
        outputCount += 1
        if (outputCount > 16)
          return yield* GatewayError.make({ kind: "transport", message: "Persisted executor lifecycle is invalid" })
      }
      if (frame._tag === "Terminal") terminal = frame
    }
    const operationKey = key(input.assignmentId, input.operationKey, input.attempt)
    yield* Ref.update(frames, (current) => new Map(current).set(operationKey, retained))
    yield* Ref.update(terminals, (current) => {
      const next = new Map(current)
      if (terminal === undefined) next.delete(operationKey)
      else next.set(operationKey, terminal)
      return next
    })
  })

  const register = Effect.fn("ExecutorGateway.register")(function* (session: Session) {
    return yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = session.access.fence.assignmentId
        const currentSession = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(assignmentId)))
        if (
          currentSession !== undefined &&
          currentSession.socket !== session.socket &&
          sameAccess(currentSession.access, session.access)
        ) {
          close(session.socket, 1008, "duplicate")
          return false
        }
        const previousAssignment = yield* Ref.get(assignments).pipe(
          Effect.map((current) => current.get(session.socket)),
        )
        const displaced = yield* Ref.modify(sessions, (current) => {
          const previous = current.get(assignmentId)
          const priorSession = previousAssignment === undefined ? undefined : current.get(previousAssignment)
          const next = new Map(current)
          if (
            previousAssignment !== undefined &&
            previousAssignment !== assignmentId &&
            priorSession?.socket === session.socket
          )
            next.delete(previousAssignment)
          next.set(assignmentId, session)
          return [{ previous, previousAssignment }, next] as const
        })
        yield* Ref.update(assignments, (current) => {
          const next = new Map(current)
          if (displaced.previous !== undefined && displaced.previous.socket !== session.socket)
            next.delete(displaced.previous.socket)
          next.set(session.socket, assignmentId)
          return next
        })
        const failed = yield* Ref.modify(
          pending,
          (
            current,
          ): readonly [ReadonlyArray<Deferred.Deferred<ExecutionResult, GatewayError>>, Map<string, Pending>] => {
            const displacedPending = [...current.entries()].filter(([, operation]) => {
              if (operation.assignmentId === assignmentId) return !sameExecutor(operation.access, session.access)
              return (
                displaced.previousAssignment !== undefined &&
                displaced.previousAssignment !== assignmentId &&
                operation.assignmentId === displaced.previousAssignment &&
                operation.socket === session.socket
              )
            })
            if (displacedPending.length === 0) return [[], current] as const
            const next = new Map(current)
            for (const [pendingKey] of displacedPending) next.delete(pendingKey)
            return [displacedPending.map(([, operation]) => operation.result), next] as const
          },
        )
        if (displaced.previous !== undefined && displaced.previous.socket !== session.socket)
          close(displaced.previous.socket, 1008, "fenced")
        yield* Effect.forEach(
          failed,
          (result) =>
            Deferred.fail(
              result,
              GatewayError.make({
                kind: "disconnected",
                message: "Executor connection was replaced before returning a result",
              }),
            ),
          { discard: true },
        )
        yield* Ref.update(pending, (current) => {
          const next = new Map(current)
          for (const [pendingKey, operation] of next)
            if (operation.assignmentId === assignmentId)
              next.set(pendingKey, { ...operation, socket: session.socket, access: session.access })
          return next
        })
        yield* Ref.update(machineCalls, (current) => {
          const next = new Map(current)
          for (const [pendingKey, operation] of next)
            if (operation.assignmentId === assignmentId)
              next.set(pendingKey, { ...operation, socket: session.socket, access: session.access })
          return next
        })
        return true
      }),
    )
  })

  const replayPending = Effect.fn("ExecutorGateway.replayPending")(function* (session: Session) {
    for (const operation of (yield* Ref.get(pending)).values()) {
      if (operation.assignmentId !== session.access.fence.assignmentId) continue
      const operationKey = key(operation.assignmentId, operation.operationKey, operation.attempt)
      const terminal = (yield* Ref.get(terminals)).get(operationKey)
      if (terminal !== undefined) {
        session.socket.send(
          encode({
            _tag: "CellTerminalReceipt",
            access: session.access,
            operationKey: operation.operationKey,
            attempt: operation.attempt,
            cursor: terminal.cursor,
          }),
        )
        continue
      }
      const retained = (yield* Ref.get(frames)).get(operationKey) ?? []
      session.socket.send(
        encode({
          _tag: "CellReplay",
          access: session.access,
          operationKey: operation.operationKey,
          attempt: operation.attempt,
          afterCursor: retained.at(-1)?.cursor ?? 0,
        }),
      )
    }
    for (const operation of (yield* Ref.get(machineCalls)).values()) {
      if (operation.assignmentId !== session.access.fence.assignmentId) continue
      session.socket.send(
        encode({
          _tag: "MachineExecute",
          access: session.access,
          operationKey: operation.operationKey,
          attempt: operation.attempt,
          machineId: operation.machineId,
          requestDigest: operation.requestDigest,
          request: operation.request,
        }),
      )
    }
  })

  const disconnected = Effect.fn("ExecutorGateway.disconnected")(function* (socket: Socket) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = yield* Ref.modify(assignments, (current) => {
          const known = current.get(socket)
          if (known === undefined) return [undefined, current] as const
          const next = new Map(current)
          next.delete(socket)
          return [known, next] as const
        })
        if (assignmentId !== undefined)
          yield* Ref.update(sessions, (current) => {
            if (current.get(assignmentId)?.socket !== socket) return current
            const next = new Map(current)
            next.delete(assignmentId)
            return next
          })
      }),
    )
  })

  const complete = Effect.fn("ExecutorGateway.complete")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    response: CellResponse,
  ) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = yield* Ref.get(assignments).pipe(Effect.map((current) => current.get(socket)))
        if (assignmentId === undefined) return
        const operation = yield* Ref.get(pending).pipe(
          Effect.map((current) => current.get(key(assignmentId, operationKey, attempt))),
        )
        if (
          operation === undefined ||
          operation.socket !== socket ||
          operation.attempt !== attempt ||
          !sameAccess(operation.access, access)
        )
          return
        const terminal = (yield* Ref.get(terminals)).get(key(assignmentId, operationKey, attempt))
        if (terminal === undefined || !equivalentResponse(terminal.response, response)) return
        const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(assignmentId)))
        if (session === undefined || session.socket !== socket || !sameAccess(session.access, operation.access)) return
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) {
          yield* Deferred.fail(operation.result, expired())
          return
        }
        yield* controller.validateAccess(redactAccess(operation.access)).pipe(
          Effect.matchEffect({
            onFailure: (error) => Deferred.fail(operation.result, accessFailure(error)),
            onSuccess: () =>
              Deferred.succeed(operation.result, {
                access: operation.access,
                response,
                outcome: terminal.outcome,
              }),
          }),
        )
      }),
    )
  })

  const persistLifecycle = Effect.fn("ExecutorGateway.persistLifecycle")(function* (
    socket: Socket,
    access: AccessWire,
    frame: CellLifecycleFrame,
  ) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = yield* Ref.get(assignments).pipe(Effect.map((current) => current.get(socket)))
        if (assignmentId === undefined)
          return yield* GatewayError.make({ kind: "fenced", message: "Executor is not registered" })
        const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(assignmentId)))
        const operationKey = key(assignmentId, frame.attribution.operationKey, frame.attribution.attempt)
        const operation = yield* Ref.get(pending).pipe(Effect.map((current) => current.get(operationKey)))
        if (
          session?.socket !== socket ||
          !sameAccess(session.access, access) ||
          operation === undefined ||
          operation.socket !== socket ||
          operation.attempt !== frame.attribution.attempt
        )
          return yield* GatewayError.make({ kind: "fenced", message: "Executor lifecycle frame has a stale session" })
        const request = operation.request
        const attribution = frame.attribution
        if (
          attribution.workspaceId !== request.workspaceId ||
          attribution.sessionId !== request.sessionId ||
          attribution.threadId !== request.threadId ||
          attribution.turnId !== request.turnId ||
          attribution.runId !== request.runId ||
          attribution.rootRunId !== request.rootRunId ||
          attribution.toolCallId !== request.toolCallId
        )
          return yield* GatewayError.make({ kind: "fenced", message: "Executor lifecycle attribution is invalid" })
        const known = (yield* Ref.get(frames)).get(operationKey) ?? []
        const existing = known.find((retained) => retained.cursor === frame.cursor)
        if (existing !== undefined && !equivalentLifecycle(existing, frame))
          return yield* GatewayError.make({
            kind: "fenced",
            message: "Executor lifecycle cursor has different content",
          })
        if (existing === undefined) {
          if (
            frame.cursor !== known.length + 1 ||
            known.some((retained) => retained._tag === "Terminal") ||
            (frame.cursor === 1 && frame._tag !== "Accepted") ||
            (frame.cursor === 2 && frame._tag !== "Started") ||
            (frame.cursor > 2 && frame._tag !== "Output" && frame._tag !== "Terminal") ||
            (frame._tag === "Output" && known.filter((retained) => retained._tag === "Output").length >= 16)
          )
            return yield* GatewayError.make({ kind: "fenced", message: "Executor lifecycle sequence is invalid" })
          yield* lifecycle.append(assignmentId, frame)
          yield* Ref.update(frames, (current) => new Map(current).set(operationKey, [...known, frame]))
        }
        if (frame._tag === "Terminal") {
          yield* Ref.update(terminals, (current) => new Map(current).set(operationKey, frame))
          socket.send(
            encode({
              _tag: "CellTerminalReceipt",
              access,
              operationKey: attribution.operationKey,
              attempt: attribution.attempt,
              cursor: frame.cursor,
            }),
          )
        }
      }),
    )
  })

  const receiveBinding = Effect.fn("ExecutorGateway.receiveBinding")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    callId: string,
    requestDigest: string,
    request: BindingRequest,
  ) {
    const operation = yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = yield* Ref.get(assignments).pipe(Effect.map((current) => current.get(socket)))
        const current =
          assignmentId === undefined
            ? undefined
            : yield* Ref.get(pending).pipe(Effect.map((values) => values.get(key(assignmentId, operationKey, attempt))))
        if (
          assignmentId === undefined ||
          current === undefined ||
          current.socket !== socket ||
          current.attempt !== attempt ||
          !sameAccess(current.access, access) ||
          request.sessionId !== current.request.sessionId ||
          request.cellId !== current.request.toolCallId
        )
          return yield* GatewayError.make({ kind: "fenced", message: "Binding call has a stale cell identity" })
        const expectedDigest = yield* digest(encodeBindingRequest(request))
        if (expectedDigest !== requestDigest)
          return yield* GatewayError.make({ kind: "fenced", message: "Binding call request digest is invalid" })
        return current
      }),
    )
    const calls = operation.bindingCalls
    const candidate = yield* Deferred.make<BindingOutcome>()
    const call = yield* Ref.modify(calls, (current) => {
      const known = current.get(callId)
      if (known !== undefined) return [known, current] as const
      const created = { requestDigest, result: candidate }
      return [created, new Map(current).set(callId, created)] as const
    })
    if (call.requestDigest !== requestDigest)
      return yield* GatewayError.make({ kind: "fenced", message: "Binding call id conflicts with a different request" })
    if (call.result === candidate) {
      const outcome = yield* operation.bindings.registry.invoke({ ...request, input: request.input }).pipe(
        Effect.provideContext(operation.bindings.context),
        Effect.matchCause({
          onFailure: (cause): BindingOutcome => {
            const bindingFailure = Option.getOrUndefined(Cause.findErrorOption(cause))
            return bindingFailure === undefined
              ? { _tag: "Unknown", message: "Binding authority was lost after its operation crossed" }
              : {
                  _tag: "Rejected",
                  failure: bindingFailure as Extract<BindingOutcome, { readonly _tag: "Rejected" }>["failure"],
                }
          },
          onSuccess: (response): BindingOutcome => {
            if (
              response._tag === "Failure" &&
              typeof response.failure === "object" &&
              response.failure !== null &&
              "_tag" in response.failure &&
              response.failure._tag === "NestedOperationFailed" &&
              "reason" in response.failure &&
              response.failure.reason === "suspended" &&
              "token" in response.failure &&
              typeof response.failure.token === "string"
            )
              return { _tag: "Suspend", token: response.failure.token }
            return { _tag: "Returned", response: response as import("@rika/remote-execution/protocol").BindingResponse }
          },
        }),
      )
      yield* Deferred.succeed(candidate, outcome)
    }
    const outcome = yield* Deferred.await(call.result)
    const currentSession = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(operation.assignmentId)))
    if (currentSession === undefined || !sameExecutor(currentSession.access, operation.access))
      return yield* GatewayError.make({ kind: "disconnected", message: "Binding result has no current executor" })
    currentSession.socket.send(
      encode({
        _tag: "BindingResult",
        access: currentSession.access,
        operationKey,
        attempt,
        callId,
        requestDigest,
        outcome,
      }),
    )
  })

  const receiveMachine = Effect.fn("ExecutorGateway.receiveMachine")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    machineId: string,
    requestDigest: string,
    outcome: MachineOutcome,
  ) {
    const assignmentId = yield* Ref.get(assignments).pipe(Effect.map((current) => current.get(socket)))
    if (assignmentId === undefined)
      return yield* GatewayError.make({ kind: "fenced", message: "Machine result came from an unknown executor" })
    const call = (yield* Ref.get(machineCalls)).get(machineKey(assignmentId, operationKey, attempt, machineId))
    if (
      call === undefined ||
      call.socket !== socket ||
      call.attempt !== attempt ||
      call.requestDigest !== requestDigest ||
      !sameAccess(call.access, access)
    )
      return yield* GatewayError.make({ kind: "fenced", message: "Machine result conflicts with its request" })
    yield* Deferred.succeed(call.result, outcome)
  })

  const publishPty = Effect.fn("ExecutorGateway.publishPty")(function* (socket: Socket, message: PtyEvent) {
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = yield* Ref.get(assignments).pipe(Effect.map((current) => current.get(socket)))
        const session = assignmentId === undefined ? undefined : (yield* Ref.get(sessions)).get(assignmentId)
        if (session?.socket !== socket || !sameAccess(session.access, message.access))
          return yield* GatewayError.make({ kind: "fenced", message: "PTY frame has a stale executor session" })
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) return yield* expired()
        yield* controller.validateAccess(redactAccess(message.access))
        yield* PubSub.publish(ptyFrames, message)
      }),
    )
  })

  const recover = Effect.fn("ExecutorGateway.recover")(function* (
    message: ExecutorMessageValue,
    error: ControllerError | GatewayError,
  ) {
    if (message._tag !== "ExecutorReconnect" || error.kind !== "fenced") return
    const current = yield* Ref.get(sessions).pipe(Effect.map((active) => active.get(message.access.fence.assignmentId)))
    if (current !== undefined) return
    const successor = {
      ...message.access,
      leaseEpoch: message.access.leaseEpoch + 1,
    }
    const acknowledged = yield* Effect.result(controller.validateAccess(redactAccess(successor)))
    if (acknowledged._tag === "Failure") return
    yield* phases
      .replace({
        assignmentId: message.access.fence.assignmentId,
        generation: message.access.fence.assignmentGeneration,
      })
      .pipe(Effect.ignoreCause)
  })

  const handle = Effect.fn("ExecutorGateway.handle")(function* (socket: Socket, message: ExecutorMessageValue) {
    if (message._tag === "CellResult" || message._tag === "CellLifecycle")
      yield* controller.validateAccess(redactAccess(message.access))
    switch (message._tag) {
      case "ExecutorHello": {
        const welcome = yield* controller.hello(redactHello(message.hello))
        const sessionToken = Redacted.value(welcome.sessionToken)
        const registered = yield* register({
          socket,
          access: {
            version: 1,
            fence: welcome.fence,
            leaseEpoch: welcome.leaseEpoch,
            sessionToken,
          },
          leaseExpiresAt: welcome.leaseExpiresAt,
        })
        if (registered) {
          const session = {
            socket,
            access: { version: 1 as const, fence: welcome.fence, leaseEpoch: welcome.leaseEpoch, sessionToken },
            leaseExpiresAt: welcome.leaseExpiresAt,
          }
          socket.send(encode({ _tag: "ExecutorWelcome", welcome: { ...welcome, sessionToken } }))
          yield* grant(session, "setup", null)
        }
        return
      }
      case "ExecutorReconnect": {
        const welcome = yield* controller.reconnect(redactAccess(message.access))
        const registered = yield* register({
          socket,
          access: { ...message.access, leaseEpoch: welcome.leaseEpoch },
          leaseExpiresAt: welcome.leaseExpiresAt,
        })
        if (registered) {
          const session = {
            socket,
            access: { ...message.access, leaseEpoch: welcome.leaseEpoch },
            leaseExpiresAt: welcome.leaseExpiresAt,
          }
          socket.send(encode({ _tag: "ExecutorReconnected", welcome }))
          yield* grant(session, "runtime", null)
          yield* replayPending(session)
        }
        return
      }
      case "ExecutorHeartbeat": {
        const receipt = yield* controller.heartbeat(redactHeartbeat(message.heartbeat))
        const registered = yield* register({
          socket,
          access: { ...message.heartbeat.access, leaseEpoch: receipt.leaseEpoch },
          leaseExpiresAt: receipt.leaseExpiresAt,
        })
        if (registered) socket.send(encode({ _tag: "LeaseReceipt", receipt }))
        return
      }
      case "CheckpointStaged": {
        const checkpoint = yield* controller.checkpoint(redactAccess(message.access), message.checkpoint)
        socket.send(
          encode({
            _tag: "CheckpointAccepted",
            checkpointId: checkpoint.checkpoint.checkpointId,
            contentDigest: checkpoint.checkpoint.contentDigest,
          }),
        )
        return
      }
      case "CheckoutRequested": {
        const credential = yield* controller.checkout(redactAccess(message.access))
        socket.send(
          encode({
            _tag: "CheckoutCredential",
            credential: { ...credential, requestId: message.requestId, token: Redacted.value(credential.token) },
          }),
        )
        return
      }
      case "CellResult":
        return yield* complete(socket, message.access, message.operationKey, message.attempt, message.response)
      case "BindingInvoke": {
        yield* controller.validateAccess(redactAccess(message.access))
        return yield* receiveBinding(
          socket,
          message.access,
          message.operationKey,
          message.attempt,
          message.callId,
          message.requestDigest,
          message.request,
        )
      }
      case "MachineResult": {
        yield* controller.validateAccess(redactAccess(message.access))
        return yield* receiveMachine(
          socket,
          message.access,
          message.operationKey,
          message.attempt,
          message.machineId,
          message.requestDigest,
          message.outcome,
        )
      }
      case "CellLifecycle":
        return yield* persistLifecycle(socket, message.access, message.frame)
      case "PtyOpened":
      case "PtyOutput":
      case "PtyReplayGap":
      case "PtyDisconnected":
      case "PtyTerminated":
        return yield* publishPty(socket, message)
    }
  })

  const receive = (socket: Socket, frame: unknown) =>
    decode(frame).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.sync(() => close(socket, 1007, "malformed")),
        onSuccess: (message) =>
          handle(socket, message).pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                recover(message, error).pipe(Effect.andThen(Effect.sync(() => failure(socket, message, error)))),
              onSuccess: () => Effect.void,
            }),
          ),
      }),
      Effect.asVoid,
    )

  const awaitSession = (assignmentId: string): Effect.Effect<Session> =>
    Effect.suspend(() =>
      Ref.get(sessions).pipe(
        Effect.flatMap((current) => {
          const session = current.get(assignmentId)
          return session === undefined
            ? Effect.sleep("100 millis").pipe(Effect.andThen(awaitSession(assignmentId)))
            : Effect.succeed(session)
        }),
      ),
    )

  const sendPty = Effect.fn("ExecutorGateway.sendPty")(function* (assignmentId: string, request: PtyRequest) {
    const connected = yield* awaitSession(assignmentId).pipe(Effect.timeoutOption("30 seconds"))
    if (Option.isNone(connected))
      return yield* GatewayError.make({ kind: "timeout", message: "Executor did not connect in time" })
    yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const session = (yield* Ref.get(sessions)).get(assignmentId)
        if (session === undefined)
          return yield* GatewayError.make({
            kind: "disconnected",
            message: "Executor disconnected before the PTY request could be sent",
          })
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) return yield* expired()
        yield* controller.validateAccess(redactAccess(session.access)).pipe(Effect.mapError(accessFailure))
        yield* Effect.try({
          try: () => session.socket.send(encode({ ...request, fence: session.access.fence })),
          catch: () => GatewayError.make({ kind: "transport", message: "Could not send the PTY request" }),
        })
      }),
    )
  })

  const ptyEvents = (assignmentId: string) =>
    Stream.fromPubSub(ptyFrames).pipe(Stream.filter((message) => message.access.fence.assignmentId === assignmentId))

  const invokeMachine = Effect.fn("ExecutorGateway.invokeMachine")(function* (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    machineId: string,
    request: MachineRequest,
  ) {
    const encodedRequest = encodeMachineRequest(request)
    const requestDigest = yield* digest(encodedRequest)
    const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(assignmentId)))
    const operation = yield* Ref.get(pending).pipe(
      Effect.map((current) => current.get(key(assignmentId, operationKey, attempt))),
    )
    if (
      session === undefined ||
      operation === undefined ||
      operation.attempt !== attempt ||
      operation.socket !== session.socket ||
      !sameExecutor(operation.access, session.access)
    )
      return { _tag: "Unknown" as const, message: "The selected executor is no longer available" }
    const result = yield* Deferred.make<MachineOutcome>()
    const mapKey = machineKey(assignmentId, operationKey, attempt, machineId)
    const candidate: MachineCall = {
      assignmentId,
      operationKey,
      attempt,
      machineId,
      requestDigest,
      request,
      socket: session.socket,
      access: session.access,
      result,
    }
    const call = yield* Ref.modify(machineCalls, (current) => {
      const known = current.get(mapKey)
      if (known !== undefined) return [known, current] as const
      return [candidate, new Map(current).set(mapKey, candidate)] as const
    })
    if (call.requestDigest !== requestDigest)
      return { _tag: "Unknown" as const, message: "A machine call id was reused with a different request" }
    if (call === candidate) {
      yield* Effect.try({
        try: () =>
          session.socket.send(
            encode({
              _tag: "MachineExecute",
              access: session.access,
              operationKey,
              attempt,
              machineId,
              requestDigest,
              request,
            }),
          ),
        catch: () => undefined,
      }).pipe(Effect.ignore)
    }
    return yield* Deferred.await(call.result)
  })

  const execute: (input: ExecuteInput) => Effect.Effect<ExecutionResult, GatewayError> = Effect.fn(
    "ExecutorGateway.execute",
  )(function* (input: ExecuteInput) {
    const connected = yield* awaitSession(input.assignmentId).pipe(Effect.timeoutOption("30 seconds"))
    if (Option.isNone(connected))
      return yield* GatewayError.make({ kind: "timeout", message: "Executor did not connect in time" })
    const pendingKey = key(input.assignmentId, input.operationKey, input.attempt)
    const operation = yield* admission.withPermits(1)(
      Effect.gen(function* () {
        const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(input.assignmentId)))
        if (session === undefined)
          return yield* GatewayError.make({
            kind: "disconnected",
            message: "Executor disconnected before work could be sent",
          })
        if ((yield* Clock.currentTimeMillis) >= session.leaseExpiresAt) return yield* expired()
        yield* controller.validateAccess(redactAccess(session.access)).pipe(Effect.mapError(accessFailure))
        yield* grant(session, "runtime", input.operationKey)
        yield* lifecycle.prepare(input)
        yield* hydrate(input)
        const durable = yield* lifecycle.inspect(input)
        const terminal = (yield* Ref.get(terminals)).get(pendingKey)
        if (terminal !== undefined)
          return {
            assignmentId: input.assignmentId,
            operationKey: input.operationKey,
            attempt: input.attempt,
            request: input,
            socket: session.socket,
            access: session.access,
            result: yield* Deferred.make<ExecutionResult, GatewayError>().pipe(
              Effect.tap((result) =>
                Deferred.succeed(result, {
                  access: session.access,
                  response: terminal.response,
                  outcome: terminal.outcome,
                }),
              ),
            ),
            waiters: 1,
          }
        if (durable.state === "unknown" || durable.started)
          if (
            durable.state === "unknown" ||
            durable.dispatchedGeneration !== session.access.fence.assignmentGeneration ||
            durable.dispatchedExecutorInstanceId !== session.access.fence.executorId ||
            durable.dispatchedProcessIncarnation !== session.access.fence.processIncarnation
          ) {
            if (durable.state !== "unknown") yield* lifecycle.markUnknown(input)
            const response =
              durable.response ??
              ({
                _tag: "DomainFailure",
                failure: { kind: "unknown", message: "Executor operation outcome is unknown after executor loss" },
              } as const)
            return {
              assignmentId: input.assignmentId,
              operationKey: input.operationKey,
              attempt: input.attempt,
              request: input,
              socket: session.socket,
              access: session.access,
              result: yield* Deferred.make<ExecutionResult, GatewayError>().pipe(
                Effect.tap((result) => Deferred.succeed(result, { response, outcome: "unknown" })),
              ),
              waiters: 1,
            }
          }
        if (
          durable.state === "dispatched" &&
          (durable.dispatchedGeneration !== session.access.fence.assignmentGeneration ||
            durable.dispatchedExecutorInstanceId !== session.access.fence.executorId ||
            durable.dispatchedProcessIncarnation !== session.access.fence.processIncarnation)
        )
          yield* lifecycle.reassign(input)
        yield* lifecycle.dispatch(input, session.access)
        const result = yield* Deferred.make<ExecutionResult, GatewayError>()
        const known = yield* Ref.get(pending).pipe(Effect.map((current) => current.get(pendingKey)))
        if (known !== undefined && known.socket === session.socket && sameAccess(known.access, session.access)) {
          yield* Ref.update(pending, (current) => {
            const currentOperation = current.get(pendingKey)
            if (currentOperation?.result !== known.result) return current
            const next = new Map(current)
            next.set(pendingKey, { ...currentOperation, waiters: currentOperation.waiters + 1 })
            return next
          })
          return known
        }
        if (known !== undefined) {
          yield* Ref.update(pending, (current) => {
            if (current.get(pendingKey)?.result !== known.result) return current
            const next = new Map(current)
            next.delete(pendingKey)
            return next
          })
          yield* Deferred.fail(
            known.result,
            GatewayError.make({
              kind: "disconnected",
              message: "Executor connection was replaced before returning a result",
            }),
          )
        }
        const created: Pending = {
          assignmentId: input.assignmentId,
          operationKey: input.operationKey,
          attempt: input.attempt,
          request: input,
          socket: session.socket,
          access: session.access,
          result,
          waiters: 1,
          bindings: input.bindings,
          bindingCalls: yield* Ref.make(new Map()),
          nextMachineOrdinal: yield* Ref.make(0),
        }
        yield* Ref.update(pending, (current) => new Map(current).set(pendingKey, created))
        yield* Effect.try({
          try: () =>
            session.socket.send(
              encode({
                _tag: "CellExecute",
                request: {
                  access: session.access,
                  operationKey: input.operationKey,
                  workspaceId: input.workspaceId,
                  sessionId: input.sessionId,
                  threadId: input.threadId,
                  turnId: input.turnId,
                  runId: input.runId,
                  toolCallId: input.toolCallId,
                  code: input.code,
                  rootRunId: input.rootRunId,
                  attempt: input.attempt,
                  replayPolicy: input.replayPolicy,
                  admittedAt: input.admittedAt,
                  deadline: input.deadline,
                  bindings: created.bindings.manifest,
                },
              }),
            ),
          catch: () => GatewayError.make({ kind: "transport", message: "Could not send work to the executor" }),
        }).pipe(
          Effect.tapError((error) => Deferred.fail(created.result, error)),
          Effect.tapError(() =>
            Ref.update(pending, (current) => {
              if (current.get(pendingKey)?.result !== created.result) return current
              const next = new Map(current)
              next.delete(pendingKey)
              return next
            }),
          ),
        )
        return created
      }),
    )
    const removePending = admission.withPermits(1)(
      Effect.all(
        [
          Ref.update(pending, (current) => {
            const known = current.get(pendingKey)
            if (known === undefined || known.result !== operation.result) return current
            const next = new Map(current)
            if (known.waiters === 1) next.delete(pendingKey)
            else next.set(pendingKey, { ...known, waiters: known.waiters - 1 })
            return next
          }),
          Ref.update(terminals, (current) => {
            const next = new Map(current)
            next.delete(pendingKey)
            return next
          }),
          Ref.update(frames, (current) => {
            const next = new Map(current)
            next.delete(pendingKey)
            return next
          }),
          Ref.update(machineCalls, (current) => {
            const prefix = `${input.assignmentId}\u0000${input.operationKey}\u0000${input.attempt}\u0000`
            return new Map(Array.from(current).filter(([callKey]) => !callKey.startsWith(prefix)))
          }),
        ],
        { discard: true },
      ),
    )
    return yield* Deferred.await(operation.result).pipe(
      Effect.timeoutOption("60 seconds"),
      Effect.flatMap((completed) => {
        if (Option.isSome(completed)) return Effect.succeed(completed.value)
        return Effect.gen(function* () {
          const durable = yield* lifecycle.inspect(input)
          if (durable.started || durable.state === "unknown") {
            if (durable.state !== "unknown") yield* lifecycle.markUnknown(input)
            return {
              response:
                durable.response ??
                ({
                  _tag: "DomainFailure",
                  failure: { kind: "unknown", message: "Executor operation outcome is unknown after executor loss" },
                } as const),
              outcome: "unknown" as const,
            }
          }
          if ((input.recoveryAttempt ?? 0) >= 1)
            return yield* GatewayError.make({
              kind: "timeout",
              message: "Executor did not accept safely reassigned work",
            })
          yield* lifecycle.reassign(input)
          yield* phases.replace({
            assignmentId: input.assignmentId,
            generation: operation.access.fence.assignmentGeneration,
          })
          return yield* execute({ ...input, recoveryAttempt: (input.recoveryAttempt ?? 0) + 1 })
        })
      }),
      Effect.onInterrupt(() =>
        Effect.try({
          try: () =>
            operation.socket.send(
              encode({
                _tag: "CellCancel",
                access: operation.access,
                operationKey: operation.operationKey,
                attempt: operation.attempt,
              }),
            ),
          catch: () => undefined,
        }).pipe(Effect.ignore),
      ),
      Effect.ensuring(removePending),
    )
  })

  const cancel = Effect.fn("ExecutorGateway.cancel")(function* (assignmentId: string, operationKey: string) {
    const operation = [...(yield* Ref.get(pending)).values()].find(
      (candidate) => candidate.assignmentId === assignmentId && candidate.operationKey === operationKey,
    )
    const session = (yield* Ref.get(sessions)).get(assignmentId)
    if (operation === undefined || session === undefined || operation.socket !== session.socket)
      return yield* GatewayError.make({ kind: "disconnected", message: "Executor operation is not running" })
    yield* Effect.try({
      try: () =>
        session.socket.send(
          encode({ _tag: "CellCancel", access: session.access, operationKey, attempt: operation.attempt }),
        ),
      catch: () => GatewayError.make({ kind: "transport", message: "Could not cancel executor operation" }),
    })
  })

  const machine = Effect.fn("ExecutorGateway.machine")(function* (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    request: MachineBindings.Request,
  ) {
    const operation = (yield* Ref.get(pending)).get(key(assignmentId, operationKey, attempt))
    if (operation === undefined)
      return yield* GatewayError.make({ kind: "disconnected", message: "Cell authority is no longer available" })
    const ordinal = yield* Ref.getAndUpdate(operation.nextMachineOrdinal, (current) => current + 1)
    return yield* invokeMachine(
      assignmentId,
      operationKey,
      attempt,
      `${operation.request.toolCallId}:${ordinal}`,
      request,
    )
  })

  const active: Gateway["active"] = (socket) =>
    Effect.gen(function* () {
      const assignmentId = (yield* Ref.get(assignments)).get(socket)
      if (assignmentId === undefined) return true
      const current = (yield* Ref.get(sessions)).get(assignmentId)
      if (current === undefined || current.socket !== socket) return false
      return yield* controller.validateAccess(redactAccess(current.access)).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
    })

  return { receive, disconnected, active, execute, cancel, machine, sendPty, ptyEvents } satisfies Gateway
})
