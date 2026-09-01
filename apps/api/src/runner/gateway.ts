import {
  HostedExecutionOperations,
  HostedExecutionOperationsError,
  layer as hostedExecutionOperationsLayer,
  type OperationRecord,
} from "@rika/product-store/executor-operations"
import type { ToolOperationResponse } from "@rika/product/tool-operation-lifecycle"
import {
  AssignmentLeaseEpoch,
  EventId,
  ExecutorAssignmentId,
  FencingGeneration,
  IdempotencyKey,
  Sequence,
} from "@rika/product/hosted-model"
import { HostedThreadEventStore } from "@rika/product/hosted-thread-event-store"
import { redactAccess, type AccessWire } from "@rika/remote-execution/protocol"
import { Crypto, Deferred, Effect, Encoding, Layer, Ref, Semaphore } from "effect"
import type { GatewayError, OperationIdentity, OperationInput, Socket, SocketFrame } from "../executor/gateway"
import type { RunnerExecutorAuthority } from "./executor"
import { runnerGatewayCalls } from "./gateway-calls"
import { runnerGatewayMessages } from "./gateway-messages"
import { runnerGatewayNative } from "./gateway-native"
import { runnerGatewayOperations } from "./gateway-operations"
import {
  gatewayModel,
  type FinalResult,
  type LocalExecuteInput,
  type MachineCall,
  type MutableFinalizeOperationInput,
  type Pending,
  type Session,
} from "./gateway-model"

const { encodeOperationIdentity, failure, finalResult, operationKey: key, sameFence: same } = gatewayModel

export interface RunnerGateway {
  readonly receive: (socket: Socket, frame: SocketFrame) => Effect.Effect<void>
  readonly disconnected: (socket: Socket) => Effect.Effect<void>
  readonly active: (socket: Socket) => Effect.Effect<boolean>
  readonly execute: (input: LocalExecuteInput) => Effect.Effect<FinalResult, GatewayError>
  readonly cancel: (input: OperationIdentity) => Effect.Effect<FinalResult, GatewayError>
}

const makeRunnerGatewayWithOperations = Effect.fn("RunnerGateway.make")(function* (authority: RunnerExecutorAuthority) {
  const operations = yield* HostedExecutionOperations
  const store = yield* HostedThreadEventStore
  const crypto = yield* Crypto.Crypto
  const scope = yield* Effect.scope
  const sessions = yield* Ref.make(new Map<string, Session>())
  const assignments = yield* Ref.make(new Map<Socket, string>())
  const machineCalls = yield* Ref.make(new Map<string, MachineCall>())
  const pending = yield* Ref.make(new Map<string, Pending>())
  const gatewayLock = yield* Semaphore.make(1)
  const machineLock = yield* Semaphore.make(1)
  const requestDigest = Effect.fn("RunnerGateway.requestDigest")(function* (code: string) {
    const bytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(code))
      .pipe(Effect.mapError(() => failure("transport", "Could not identify Runner operation")))
    return Encoding.encodeHex(bytes)
  })
  const machineIdFor = (operationKey: string, attempt: number) => requestDigest(`${attempt}\u0000${operationKey}`)
  const calls = runnerGatewayCalls({
    requestDigest,
    machineIdFor,
    send: (socket, frame) => socket.send(frame),
    state: { sessions, assignments, pending, machineCalls, machineLock },
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
          return [prior, new Map(current).set(id, session)] as const
        })
        yield* Ref.update(assignments, (current) => {
          const next = new Map(current)
          if (previous !== undefined && previous.socket !== session.socket) next.delete(previous.socket)
          next.set(session.socket, id)
          return next
        })
        yield* Ref.update(pending, (current) => {
          const next = new Map(current)
          for (const [operationKey, entry] of next)
            if (entry.assignmentId === id)
              next.set(operationKey, { ...entry, socket: session.socket, access: session.access })
          return next
        })
        yield* calls.sessionRegistered(session)
        if (previous !== undefined && previous.socket !== session.socket) previous.socket.close(1008, "fenced")
      }),
    )
  })
  const replayPending = (session: Session) => calls.replayMachineCalls(session)
  const finalize = Effect.fn("RunnerGateway.finalize")(function* (input: {
    readonly assignmentId?: string
    readonly access?: AccessWire
    readonly operationKey: string
    readonly attempt: number
    readonly response: ToolOperationResponse
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
        event: { _tag: "ToolResult", operationKey: input.operationKey, response: persisted.response },
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
    const resultAccess = input.access ?? (yield* Ref.get(sessions)).get(assignmentId)?.access
    if (persisted._tag === "already-terminal") return finalResult(persisted.response, persisted.outcome, resultAccess)
    if (persisted._tag === "response-conflict")
      return yield* failure("fenced", "Runner operation already has a different terminal result")
    if (persisted._tag === "missing") return yield* failure("transport", "Runner operation is unavailable")
    if (persisted._tag === "command-missing") return yield* failure("transport", "Runner command is unavailable")
    if (persisted._tag !== "finalized")
      return yield* failure("fenced", "Runner operation was not dispatched to this fence")
    return finalResult(persisted.response, persisted.outcome, resultAccess)
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
  const nativeRun = runnerGatewayNative.make(
    operations,
    pending,
    calls.invokeMachine,
    machineIdFor,
    finalize,
    settlePending,
  ).run
  const disconnected = Effect.fn("RunnerGateway.disconnected")(function* (socket: Socket) {
    yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const id = (yield* Ref.get(assignments)).get(socket)
        if (id === undefined) return
        const currentSession = (yield* Ref.get(sessions)).get(id)
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
  const receive = runnerGatewayMessages({ authority, register, replayPending, shutdown, calls })
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
    runNative: (operation) => nativeRun(operation).pipe(Effect.forkIn(scope), Effect.asVoid),
    cancelNative: calls.cancelMachineOperation,
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
  } satisfies RunnerGateway
})

export const makeRunnerGateway = Effect.fn("RunnerGateway.makeLive")(function* (authority: RunnerExecutorAuthority) {
  const context = yield* Layer.build(hostedExecutionOperationsLayer)
  return yield* makeRunnerGatewayWithOperations(authority).pipe(Effect.provideContext(context))
})
