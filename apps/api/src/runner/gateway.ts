import {
  HostedExecutionOperations,
  HostedExecutionOperationsError,
  layer as hostedExecutionOperationsLayer,
  type OperationRecord,
} from "@rika/product-store/executor-operations"
import {
  redactAccess,
  type AccessWire,
  type CellLifecycleFrame,
  type CellResponse,
} from "@rika/remote-execution/protocol"
import {
  AssignmentLeaseEpoch,
  EventId,
  ExecutorAssignmentId,
  FencingGeneration,
  IdempotencyKey,
  Sequence,
} from "@rika/product/hosted-model"
import { HostedThreadEventStore } from "@rika/product/hosted-thread-event-store"
import { Crypto, Deferred, Effect, Encoding, FiberSet, Layer, Ref, Semaphore } from "effect"
import { GatewayError, type ExecutorDataPlane, type OperationIdentity, type OperationInput } from "../executor/gateway"
import type { HostedToolPolicyService } from "../hosted/execution/tool-policy"
import type { RunnerExecutorAuthority } from "./executor"
import type { Socket } from "../executor/gateway"
import { runnerGatewayCalls } from "./gateway-calls"
import { runnerGatewayMessages } from "./gateway-messages"
import { runnerGatewayOperations, sendCellExecute } from "./gateway-operations"
import {
  gatewayModel,
  type FinalResult,
  type LocalExecuteInput,
  type MachineCall,
  type MutableFinalizeOperationInput,
  type Pending,
  type Session,
} from "./gateway-model"
const { encode, encodeOperationIdentity, failure, finalResult, operationKey: key, sameFence: same } = gatewayModel
export interface RunnerGateway extends ExecutorDataPlane {
  readonly execute: (input: LocalExecuteInput) => Effect.Effect<FinalResult, GatewayError>
}
const makeRunnerGatewayWithOperations = Effect.fn("RunnerGateway.make")(function* (
  authority: RunnerExecutorAuthority,
  toolPolicy: HostedToolPolicyService,
) {
  const operations = yield* HostedExecutionOperations
  const store = yield* HostedThreadEventStore
  const crypto = yield* Crypto.Crypto
  const sessions = yield* Ref.make(new Map<string, Session>())
  const assignments = yield* Ref.make(new Map<Socket, string>())
  const machineCalls = yield* Ref.make(new Map<string, MachineCall>())
  const pending = yield* Ref.make(new Map<string, Pending>())
  const redeliveries = yield* FiberSet.make<void>()
  const gatewayLock = yield* Semaphore.make(1)
  const lifecycleLock = yield* Semaphore.make(1)
  const machineLock = yield* Semaphore.make(1)
  const requestDigest = Effect.fn("RunnerGateway.requestDigest")(function* (code: string) {
    const bytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(code))
      .pipe(Effect.mapError(() => failure("transport", "Could not identify Runner operation")))
    return Encoding.encodeHex(bytes)
  })
  const calls = runnerGatewayCalls({
    crypto,
    toolPolicy,
    requestDigest,
    send: (socket, frame) => socket.send(frame),
    state: { sessions, assignments, pending, machineCalls, gatewayLock, machineLock },
  })
  const identifyOperation = (input: OperationIdentity) =>
    requestDigest(
      encodeOperationIdentity({
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        threadId: input.threadId,
        turnId: input.turnId,
        runId: input.runId,
        rootRunId: input.rootRunId,
        toolCallId: input.toolCallId,
        code: input.code,
        attempt: input.attempt,
        replayPolicy: input.replayPolicy,
      }),
    )
  const matchesOperation = (input: OperationIdentity, row: OperationRecord, digest: string) =>
    row.requestDigest === digest &&
    row.workspaceId === input.workspaceId &&
    row.sessionId === input.sessionId &&
    row.threadId === input.threadId &&
    row.turnId === input.turnId &&
    row.runId === input.runId &&
    row.rootRunId === input.rootRunId &&
    row.toolCallId === input.toolCallId &&
    row.code === input.code &&
    row.attempt === input.attempt &&
    row.replayPolicy === input.replayPolicy
  const prepare = Effect.fn("RunnerGateway.prepare")(function* (input: OperationInput) {
    const digest = yield* identifyOperation(input)
    const row = yield* operations
      .upsertOperation({ ...input, requestDigest: digest })
      .pipe(Effect.mapError(() => failure("transport", "Could not persist Runner operation")))
    if (row === undefined) return yield* failure("transport", "Runner operation is unavailable")
    if (!matchesOperation(input, row, digest))
      return yield* failure("fenced", "Runner operation key conflicts with a different request")
    return row
  })
  const claimDispatch = Effect.fn("RunnerGateway.claimDispatch")(function* (input: {
    readonly session: Session
    readonly operationKey: string
    readonly attempt: number
  }) {
    const sessionDigest = yield* requestDigest(input.session.access.sessionToken)
    const operation = yield* operations
      .findOperation({
        assignmentId: input.session.access.fence.assignmentId,
        operationKey: input.operationKey,
        attempt: input.attempt,
      })
      .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
    if (operation === undefined) return yield* failure("transport", "Runner operation is unavailable")
    const disposition = yield* operations
      .claimDispatch(
        operation,
        {
          assignmentGeneration: input.session.access.fence.assignmentGeneration,
          leaseEpoch: input.session.access.leaseEpoch,
          providerInstanceId: input.session.access.fence.instanceId,
          executorInstanceId: input.session.access.fence.executorId,
          processIncarnation: input.session.access.fence.processIncarnation,
        },
        sessionDigest,
      )
      .pipe(Effect.mapError(() => failure("transport", "Could not claim Runner fence")))
    if (disposition === "missing") return yield* failure("transport", "Runner operation is unavailable")
    if (disposition !== "claimed" && disposition !== "same-fence")
      return yield* failure("fenced", "Runner fence is no longer current")
  })
  const register = Effect.fn("RunnerGateway.register")(function* (session: Session) {
    return yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const id = session.access.fence.assignmentId
        const previous = yield* Ref.modify(sessions, (current) => {
          const prior = current.get(id)
          const next = new Map(current)
          next.set(id, session)
          return [prior, next] as const
        })
        yield* Ref.update(assignments, (current) => {
          const next = new Map(current)
          if (previous !== undefined && previous.socket !== session.socket) next.delete(previous.socket)
          next.set(session.socket, id)
          return next
        })
        yield* Ref.update(pending, (current) => {
          const next = new Map(current)
          for (const [operationKey, entry] of next) {
            if (entry.assignmentId === id)
              next.set(operationKey, { ...entry, socket: session.socket, access: session.access })
          }
          return next
        })
        yield* calls.sessionRegistered(session)
        if (previous !== undefined && previous.socket !== session.socket) previous.socket.close(1008, "fenced")
      }),
    )
  })
  const replayPending = Effect.fn("RunnerGateway.replayPending")(function* (session: Session) {
    const delivered = new Set<string>()
    for (const operation of (yield* Ref.get(pending)).values()) {
      if (operation.assignmentId !== session.access.fence.assignmentId) continue
      delivered.add(key(operation.assignmentId, operation.operationKey, operation.attempt))
      yield* sendCellExecute(operation)
    }
    const queuedOperations = yield* operations
      .replayQueue(session.access.fence.assignmentId)
      .pipe(Effect.mapError(() => failure("transport", "Could not load Runner replay queue")))
    for (const queued of queuedOperations) {
      if (delivered.has(key(session.access.fence.assignmentId, queued.operationKey, queued.attempt))) continue
      session.socket.send(
        encode({
          _tag: "CellReplay",
          access: session.access,
          operationKey: queued.operationKey,
          attempt: queued.attempt,
          afterCursor: queued.afterCursor,
        }),
      )
    }
    yield* calls.replayMachineCalls(session)
  })
  const finalize = Effect.fn("RunnerGateway.finalize")(function* (input: {
    readonly assignmentId?: string
    readonly access?: AccessWire
    readonly operationKey: string
    readonly attempt: number
    readonly response: CellResponse
    readonly state: "completed" | "unknown"
    readonly dispatchedFence?: {
      readonly assignmentGeneration: string
      readonly leaseEpoch: string
      readonly executorInstanceId: string
      readonly processIncarnation: string
    }
  }) {
    const assignmentId = input.access?.fence.assignmentId ?? input.assignmentId
    if (assignmentId === undefined) return yield* failure("fenced", "Runner assignment is unavailable")
    const recovering = input.access === undefined
    const completionFence =
      input.access === undefined
        ? undefined
        : {
            assignmentGeneration: input.access.fence.assignmentGeneration,
            leaseEpoch: input.access.leaseEpoch,
            executorInstanceId: input.access.fence.executorId,
            processIncarnation: input.access.fence.processIncarnation,
          }
    const finalizeInput: MutableFinalizeOperationInput = {
      assignmentId,
      operationKey: input.operationKey,
      attempt: input.attempt,
      response: input.response,
      state: input.state,
    }
    if (completionFence !== undefined) finalizeInput.completionFence = completionFence
    if (input.dispatchedFence !== undefined)
      finalizeInput.expectedFence = {
        ...input.dispatchedFence,
        assignmentGeneration: Number(input.dispatchedFence.assignmentGeneration),
        leaseEpoch: Number(input.dispatchedFence.leaseEpoch),
      }
    finalizeInput.onFinalize = (persisted) => {
      const event: Parameters<typeof store.appendEvent>[0] = {
        eventId: EventId.make(input.operationKey),
        idempotencyKey: IdempotencyKey.make(input.operationKey),
        assignmentId: ExecutorAssignmentId.make(assignmentId),
        assignmentGeneration: FencingGeneration.make(String(persisted.fence.assignmentGeneration)),
        leaseEpoch: AssignmentLeaseEpoch.make(
          input.access === undefined ? String(persisted.fence.leaseEpoch) : String(input.access.leaseEpoch),
        ),
        commandSequence: Sequence.make(String(persisted.commandSequence)),
        event: { _tag: "CellResult", operationKey: input.operationKey, response: persisted.response },
      }
      if (recovering)
        return store
          .appendRecoveredEvent({
            ...event,
            assignmentGeneration: FencingGeneration.make(String(persisted.fence.assignmentGeneration)),
            leaseEpoch: AssignmentLeaseEpoch.make(String(persisted.fence.leaseEpoch)),
            executorInstanceId: persisted.fence.executorInstanceId,
            processIncarnation: persisted.fence.processIncarnation,
          })
          .pipe(Effect.mapError((cause) => HostedExecutionOperationsError.make({ message: cause.message })))
      return store
        .appendEvent(event)
        .pipe(Effect.mapError((cause) => HostedExecutionOperationsError.make({ message: cause.message })))
    }
    const persisted = yield* operations
      .finalizeOperation(finalizeInput)
      .pipe(Effect.mapError(() => failure("transport", "Could not persist Runner result")))
    if (persisted._tag === "already-terminal") return finalResult(persisted.response, persisted.outcome, input.access)
    if (persisted._tag === "response-conflict")
      return yield* failure("fenced", "Runner operation already has a different terminal result")
    if (persisted._tag === "missing") return yield* failure("transport", "Runner operation is unavailable")
    if (persisted._tag === "command-missing") return yield* failure("transport", "Runner command is unavailable")
    if (persisted._tag !== "finalized")
      return yield* failure("fenced", "Runner operation was not dispatched to this fence")
    return finalResult(persisted.response, persisted.outcome, input.access)
  })
  const retirePending = Effect.fn("RunnerGateway.retirePending")(function* (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    expected?: Pending,
  ) {
    const pendingKey = key(assignmentId, operationKey, attempt)
    const entry = yield* gatewayLock.withPermits(1)(
      Ref.modify(pending, (current) => {
        const known = current.get(pendingKey)
        if (known === undefined || (expected !== undefined && known !== expected)) return [undefined, current] as const
        const next = new Map(current)
        next.delete(pendingKey)
        return [known, next] as const
      }),
    )
    if (entry === undefined) return undefined
    yield* Deferred.succeed(entry.acknowledged, undefined)
    yield* calls.retireOperation(assignmentId, operationKey, attempt)
    return entry
  })
  const settlePending = Effect.fn("RunnerGateway.settlePending")(function* (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    result: FinalResult,
  ) {
    const entry = yield* retirePending(assignmentId, operationKey, attempt)
    if (entry !== undefined) yield* Deferred.succeed(entry.result, result)
  })
  const sendCancel = Effect.fn("RunnerGateway.sendCancel")(function* (
    assignmentId: string,
    operationKey: string,
    attempt: number,
  ) {
    const session = (yield* Ref.get(sessions)).get(assignmentId)
    if (session === undefined) return
    yield* Effect.try({
      try: () => session.socket.send(encode({ _tag: "CellCancel", access: session.access, operationKey, attempt })),
      catch: () => undefined,
    }).pipe(Effect.ignore)
  })
  const disconnected = Effect.fn("RunnerGateway.disconnected")(function* (socket: Socket) {
    yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const id = yield* Ref.get(assignments).pipe(Effect.map((current) => current.get(socket)))
        if (id === undefined) return
        const currentSession = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(id)))
        yield* Ref.update(assignments, (current) => {
          const next = new Map(current)
          next.delete(socket)
          return next
        })
        if (currentSession?.socket === socket)
          yield* Ref.update(sessions, (current) => {
            const next = new Map(current)
            next.delete(id)
            return next
          })
      }),
    )
  })
  const shutdown = Effect.fn("RunnerGateway.shutdown")(function* (socket: Socket, access: AccessWire) {
    const assignmentId = (yield* Ref.get(assignments)).get(socket)
    const session = assignmentId === undefined ? undefined : (yield* Ref.get(sessions)).get(assignmentId)
    if (
      assignmentId === undefined ||
      assignmentId !== access.fence.assignmentId ||
      session?.socket !== socket ||
      !same(session.access, access)
    )
      return yield* failure("fenced", "Runner shutdown does not match the current session")
    yield* disconnected(socket)
    yield* authority.release(redactAccess(access)).pipe(Effect.ignore)
  })
  const complete = Effect.fn("RunnerGateway.complete")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    response: CellResponse,
  ) {
    const pendingCurrent = yield* gatewayLock.withPermits(1)(
      Ref.get(pending).pipe(Effect.map((value) => value.get(key(access.fence.assignmentId, operationKey, attempt)))),
    )
    yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const id = yield* Ref.get(assignments).pipe(Effect.map((value) => value.get(socket)))
        if (id === undefined || id !== access.fence.assignmentId)
          return yield* failure("fenced", "Runner result came from an unregistered socket")
        const currentSession = yield* Ref.get(sessions).pipe(Effect.map((value) => value.get(id)))
        if (currentSession === undefined || currentSession.socket !== socket || !same(currentSession.access, access))
          return yield* failure("fenced", "Runner result does not match the current executor session")
        if (pendingCurrent !== undefined && pendingCurrent.attempt !== attempt)
          return yield* failure("fenced", "Runner result attempt is stale")
      }),
    )
    const persisted = yield* operations
      .findOperation({ assignmentId: access.fence.assignmentId, operationKey, attempt })
      .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
    if (persisted === undefined) return yield* failure("fenced", "Runner operation is unavailable")
    if (persisted.state === "completed" || persisted.state === "unknown") {
      const result = yield* finalize({ access, operationKey, attempt, response, state: "completed" })
      if (pendingCurrent !== undefined) yield* Deferred.succeed(pendingCurrent.result, result)
      return result
    }
    const terminalFrame = yield* operations
      .terminalFrame({ assignmentId: access.fence.assignmentId, operationKey, attempt })
      .pipe(Effect.mapError(() => failure("transport", "Could not read Runner terminal receipt")))
    if (terminalFrame === undefined)
      return yield* failure("fenced", "Runner result arrived before its terminal receipt")
    const result = yield* finalize({ access, operationKey, attempt, response, state: "completed" }).pipe(
      Effect.tapError((error) =>
        pendingCurrent === undefined ? Effect.void : Deferred.fail(pendingCurrent.result, error).pipe(Effect.asVoid),
      ),
    )
    yield* settlePending(access.fence.assignmentId, operationKey, attempt, result)
    return result
  })
  const persistLifecycle = Effect.fn("RunnerGateway.persistLifecycle")(function* (
    socket: Socket,
    access: AccessWire,
    frame: CellLifecycleFrame,
  ) {
    yield* lifecycleLock.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = yield* Ref.get(assignments).pipe(Effect.map((value) => value.get(socket)))
        const session =
          assignmentId === undefined
            ? undefined
            : yield* Ref.get(sessions).pipe(Effect.map((value) => value.get(assignmentId)))
        if (assignmentId === undefined || session?.socket !== socket || !same(session.access, access))
          return yield* failure("fenced", "Runner lifecycle frame has a stale session")
        const attribution = frame.attribution
        const disposition = yield* operations
          .appendFrame(assignmentId, frame)
          .pipe(Effect.mapError(() => failure("transport", "Could not persist Runner lifecycle frame")))
        if (disposition === "invalid-sequence")
          return yield* failure("fenced", "Runner lifecycle sequence or attribution is invalid")
        const operation = (yield* Ref.get(pending)).get(
          key(assignmentId, frame.attribution.operationKey, frame.attribution.attempt),
        )
        if (operation !== undefined) yield* Deferred.succeed(operation.acknowledged, undefined)
        if (frame._tag === "Terminal") {
          if (frame.outcome === "cancelled")
            yield* calls.settleCancelledOperation(assignmentId, attribution.operationKey, attribution.attempt)
          if (disposition === "appended") {
            const result = yield* finalize({
              access,
              operationKey: attribution.operationKey,
              attempt: attribution.attempt,
              response: frame.response,
              state: frame.outcome === "unknown" ? "unknown" : "completed",
            })
            yield* settlePending(assignmentId, attribution.operationKey, attribution.attempt, result)
          }
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
  const receive = runnerGatewayMessages({
    authority,
    register,
    replayPending,
    persistLifecycle,
    shutdown,
    complete,
    calls,
  })
  const operationGateway = runnerGatewayOperations({
    authority,
    operations,
    store,
    sessions,
    pending,
    gatewayLock,
    prepare,
    claimDispatch,
    identifyOperation,
    matchesOperation,
    finalize,
    settlePending,
    retirePending,
    sendCancel,
    redeliveries,
  })
  yield* operationGateway.recovery.pipe(Effect.forkScoped)
  const active: RunnerGateway["active"] = (socket) =>
    Effect.gen(function* () {
      const assignmentId = (yield* Ref.get(assignments)).get(socket)
      if (assignmentId === undefined) return true
      const current = (yield* Ref.get(sessions)).get(assignmentId)
      if (current === undefined || current.socket !== socket) return false
      return yield* authority.validateAccess(redactAccess(current.access)).pipe(
        Effect.as(true),
        Effect.catch((error) => Effect.succeed(error.kind === "repository")),
      )
    })
  return {
    receive,
    disconnected,
    active,
    execute: operationGateway.execute,
    cancel: operationGateway.cancel,
    machine: calls.machine,
  }
})
export const makeRunnerGateway = Effect.fn("RunnerGateway.makeLive")(function* (
  authority: RunnerExecutorAuthority,
  toolPolicy: HostedToolPolicyService,
) {
  const context = yield* Layer.build(hostedExecutionOperationsLayer)
  return yield* makeRunnerGatewayWithOperations(authority, toolPolicy).pipe(Effect.provideContext(context))
})
