import type * as MachineBindings from "@rika/kernel/machine-bindings"
import {
  HostedExecutionOperations,
  HostedExecutionOperationsError,
  layer as hostedExecutionOperationsLayer,
  type FinalizeOperationInput,
  type OperationRecord,
} from "@rika/product-store/executor-operations"
import {
  ApiMessage,
  RunnerMessage,
  redactAccess,
  redactHeartbeat,
  type AccessWire,
  type CellLifecycleFrame,
  type CellResponse,
  BindingRequest,
  MachineRequest,
  type BindingOutcome,
  type MachineOutcome,
} from "@rika/remote-execution/protocol"
import {
  AssignmentLeaseEpoch,
  EventId,
  ExecutorAssignmentId,
  FencingGeneration,
  IdempotencyKey,
  Sequence,
} from "@rika/product/hosted-model"
import { HostedStore } from "@rika/product/hosted-store"
import {
  Cause,
  Clock,
  Crypto,
  DateTime,
  Deferred,
  Effect,
  Encoding,
  Exit,
  Layer,
  Redacted,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import {
  cancelledResponse,
  GatewayError,
  type BindingAuthority,
  type ExecutionOutcome,
  type ExecutorDataPlane,
  type OperationIdentity,
  type OperationInput,
  type SocketFrame,
} from "../executor/gateway"
import { invokeAdmittedTool, type HostedToolPolicyService } from "../hosted/execution/tool-policy"
import type { RunnerExecutorAuthority } from "./executor"
import type { Socket } from "../executor/gateway"

interface Session {
  readonly socket: Socket
  readonly access: AccessWire
  readonly leaseExpiresAt: number
}

interface FinalResult {
  readonly access?: AccessWire
  readonly response: CellResponse
  readonly outcome: ExecutionOutcome
  readonly eventPersisted: boolean
}

interface Pending {
  readonly assignmentId: string
  readonly operationKey: string
  readonly attempt: number
  readonly code: string
  readonly request: LocalExecuteInput
  readonly socket: Socket
  readonly access: AccessWire
  readonly result: Deferred.Deferred<FinalResult, GatewayError>
  readonly bindings: BindingAuthority
  readonly bindingCalls: Ref.Ref<Map<string, BindingCall>>
  readonly bindingLock: Semaphore.Semaphore
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
  readonly request: MachineBindings.Request
  readonly socket: Socket
  readonly access: AccessWire
  readonly deadlineAtMillis: number
  readonly result: Deferred.Deferred<MachineBindings.Outcome>
}

type LocalExecuteInput = OperationInput & {
  readonly bindings: BindingAuthority
}

type MutableFinalizeOperationInput = {
  -readonly [Key in keyof FinalizeOperationInput]: FinalizeOperationInput[Key]
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ApiMessage))
const OperationIdentity = Schema.Struct({
  workspaceId: Schema.String,
  sessionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  runId: Schema.String,
  rootRunId: Schema.String,
  toolCallId: Schema.String,
  code: Schema.String,
  attempt: Schema.Int,
  replayPolicy: Schema.Literals(["pure", "provider-idempotent", "never"]),
})
const encodeOperationIdentity = Schema.encodeSync(Schema.fromJsonString(OperationIdentity))
const encodeBindingRequest = Schema.encodeSync(Schema.fromJsonString(BindingRequest))
const encodeMachineRequest = Schema.encodeSync(Schema.fromJsonString(MachineRequest))
const key = (assignmentId: string, operationKey: string, attempt: number) =>
  `${assignmentId}\u001f${operationKey}\u001f${attempt}`
const machineKey = (assignmentId: string, operationKey: string, attempt: number, machineId: string) =>
  `${assignmentId}\u001f${operationKey}\u001f${attempt}\u001f${machineId}`
const failure = (kind: GatewayError["kind"], message: string): GatewayError => GatewayError.make({ kind, message })
const finalResult = (response: CellResponse, outcome: ExecutionOutcome, access?: AccessWire): FinalResult => {
  const result: FinalResult = { response, outcome, eventPersisted: true }
  if (access !== undefined) return { ...result, access }
  return result
}
const same = (left: AccessWire, right: AccessWire) =>
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  left.fence.assignmentId === right.fence.assignmentId &&
  left.fence.assignmentGeneration === right.fence.assignmentGeneration &&
  left.fence.target === right.fence.target &&
  left.fence.instanceId === right.fence.instanceId &&
  left.fence.executorId === right.fence.executorId &&
  left.fence.processIncarnation === right.fence.processIncarnation

const unknownResponse: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
}

const timeoutResponse: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
}

export interface RunnerGateway extends ExecutorDataPlane {
  readonly execute: (input: LocalExecuteInput) => Effect.Effect<FinalResult, GatewayError>
}

const makeRunnerGatewayWithOperations = Effect.fn("RunnerGateway.make")(function* (
  authority: RunnerExecutorAuthority,
  toolPolicy: HostedToolPolicyService,
) {
  const operations = yield* HostedExecutionOperations
  const store = yield* HostedStore
  const crypto = yield* Crypto.Crypto
  const sessions = yield* Ref.make(new Map<string, Session>())
  const assignments = yield* Ref.make(new Map<Socket, string>())
  const machineCalls = yield* Ref.make(new Map<string, MachineCall>())
  const pending = yield* Ref.make(new Map<string, Pending>())
  const gatewayLock = yield* Semaphore.make(1)
  const lifecycleLock = yield* Semaphore.make(1)
  const machineLock = yield* Semaphore.make(1)

  const requestDigest = Effect.fn("RunnerGateway.requestDigest")(function* (code: string) {
    const bytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(code))
      .pipe(Effect.mapError(() => failure("transport", "Could not identify Runner operation")))
    return Encoding.encodeHex(bytes)
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
        yield* machineLock.withPermits(1)(
          Ref.update(machineCalls, (current) => {
            const next = new Map(current)
            for (const [callKey, call] of next)
              if (call.assignmentId === id)
                next.set(callKey, { ...call, socket: session.socket, access: session.access })
            return next
          }),
        )
        if (previous !== undefined && previous.socket !== session.socket) previous.socket.close(1008, "fenced")
      }),
    )
  })

  const replayPending = Effect.fn("RunnerGateway.replayPending")(function* (session: Session) {
    const queuedOperations = yield* operations
      .replayQueue(session.access.fence.assignmentId)
      .pipe(Effect.mapError(() => failure("transport", "Could not load Runner replay queue")))
    for (const queued of queuedOperations)
      session.socket.send(
        encode({
          _tag: "CellReplay",
          access: session.access,
          operationKey: queued.operationKey,
          attempt: queued.attempt,
          afterCursor: queued.afterCursor,
        }),
      )
    yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          for (const [mapKey, call] of yield* Ref.get(machineCalls)) {
            if (call.assignmentId !== session.access.fence.assignmentId) continue
            if (now >= call.deadlineAtMillis) {
              yield* Deferred.succeed(call.result, machineDeadlineOutcome)
              yield* Ref.update(machineCalls, (current) => {
                if (current.get(mapKey)?.result !== call.result) return current
                const next = new Map(current)
                next.delete(mapKey)
                return next
              })
              continue
            }
            session.socket.send(
              encode({
                _tag: "MachineExecute",
                access: session.access,
                operationKey: call.operationKey,
                attempt: call.attempt,
                machineId: call.machineId,
                requestDigest: call.requestDigest,
                request: call.request,
              }),
            )
          }
        }),
      ),
    )
  })

  const receiveBinding = Effect.fn("RunnerGateway.receiveBinding")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    callId: string,
    digest: string,
    request: BindingRequest,
  ) {
    const assignmentId = (yield* Ref.get(assignments)).get(socket)
    const pendingOperation =
      assignmentId === undefined ? undefined : (yield* Ref.get(pending)).get(key(assignmentId, operationKey, attempt))
    if (assignmentId === undefined) return yield* failure("fenced", "Local binding call has no executor")
    if (pendingOperation === undefined || (yield* Deferred.isDone(pendingOperation.result))) return
    if (
      pendingOperation.socket !== socket ||
      pendingOperation.attempt !== attempt ||
      !same(pendingOperation.access, access) ||
      request.sessionId !== pendingOperation.request.sessionId ||
      request.cellId !== pendingOperation.request.toolCallId
    )
      return yield* failure("fenced", "Local binding call has a stale cell identity")
    return yield* pendingOperation.bindingLock.withPermits(1)(
      Effect.gen(function* () {
        const expected = yield* requestDigest(encodeBindingRequest(request))
        if (expected !== digest) return yield* failure("fenced", "Local binding request digest is invalid")
        const candidate = yield* Deferred.make<BindingOutcome>()
        const call = yield* Ref.modify(pendingOperation.bindingCalls, (current) => {
          const known = current.get(callId)
          if (known !== undefined) return [known, current] as const
          const created = { requestDigest: digest, result: candidate }
          return [created, new Map(current).set(callId, created)] as const
        })
        if (call.requestDigest !== digest)
          return yield* failure("fenced", "Local binding call id conflicts with a different request")
        const remaining = Math.max(
          0,
          DateTime.toEpochMillis(DateTime.makeUnsafe(pendingOperation.request.deadlineAt)) -
            (yield* Clock.currentTimeMillis),
        )
        const deadlineOutcome = {
          _tag: "Unknown" as const,
          message: "Cell binding outcome is unknown at the operation deadline",
        }
        if (call.result === candidate) {
          const outcome = yield* invokeAdmittedTool({
            policyService: toolPolicy,
            threadId: pendingOperation.request.threadId,
            turnId: pendingOperation.request.turnId,
            workspaceId: pendingOperation.request.workspaceId,
            operationKey,
            callId,
            request,
            access,
            invoke: pendingOperation.bindings.registry.invoke({ ...request, input: request.input }),
          }).pipe(
            Effect.provideContext(pendingOperation.bindings.context),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.succeed(deadlineOutcome) }),
            Effect.orElseSucceed(
              (): BindingOutcome => ({
                _tag: "Unknown",
                message: "Tool admission could not durably record its decision",
              }),
            ),
            Effect.onInterrupt(() => Deferred.succeed(candidate, deadlineOutcome).pipe(Effect.asVoid)),
          )
          yield* Deferred.succeed(candidate, outcome)
        }
        const outcome = yield* Deferred.await(call.result).pipe(
          Effect.timeoutOrElse({
            duration: remaining,
            orElse: () =>
              Deferred.succeed(call.result, deadlineOutcome).pipe(Effect.andThen(Deferred.await(call.result))),
          }),
        )
        yield* gatewayLock.withPermits(1)(
          Effect.gen(function* () {
            const assigned = (yield* Ref.get(assignments)).get(socket)
            const current = (yield* Ref.get(sessions)).get(pendingOperation.assignmentId)
            if (
              assigned !== pendingOperation.assignmentId ||
              current?.socket !== socket ||
              !same(current.access, access)
            )
              return yield* failure("disconnected", "Local binding result has no executor")
            socket.send(
              encode({
                _tag: "BindingResult",
                access,
                operationKey,
                attempt,
                callId,
                requestDigest: digest,
                outcome,
              }),
            )
          }),
        )
      }),
    )
  })

  const machineDeadlineOutcome: MachineOutcome = {
    _tag: "Unknown",
    message: "Machine outcome is unknown at the operation deadline",
  }
  const settleMachine = Effect.fn("RunnerGateway.settleMachine")(function* (
    mapKey: string,
    call: MachineCall,
    outcome: MachineOutcome,
  ) {
    yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          yield* Deferred.succeed(call.result, outcome)
          yield* Ref.update(machineCalls, (current) => {
            if (current.get(mapKey)?.result !== call.result) return current
            const next = new Map(current)
            next.delete(mapKey)
            return next
          })
        }),
      ),
    )
    return yield* Deferred.await(call.result)
  })

  const settleCancelledOperation = Effect.fn("RunnerGateway.settleCancelledOperation")(function* (
    assignmentId: string,
    operationKey: string,
    attempt: number,
  ) {
    yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(machineCalls)
          const next = new Map(current)
          for (const [mapKey, call] of current) {
            if (call.assignmentId !== assignmentId || call.operationKey !== operationKey || call.attempt !== attempt)
              continue
            yield* Deferred.succeed(call.result, { _tag: "Cancelled" })
            next.delete(mapKey)
          }
          yield* Ref.set(machineCalls, next)
        }),
      ),
    )
    const pendingOperation = (yield* Ref.get(pending)).get(key(assignmentId, operationKey, attempt))
    if (pendingOperation === undefined) return
    const calls = [...(yield* Ref.get(pendingOperation.bindingCalls)).values()]
    yield* Effect.forEach(calls, (call) => Deferred.await(call.result), { concurrency: "unbounded", discard: true })
  })

  const receiveMachine = Effect.fn("RunnerGateway.receiveMachine")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    machineId: string,
    digest: string,
    outcome: MachineOutcome,
  ) {
    yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const assignmentId = (yield* Ref.get(assignments)).get(socket)
        const current = assignmentId === undefined ? undefined : (yield* Ref.get(sessions)).get(assignmentId)
        if (assignmentId === undefined || current?.socket !== socket || !same(current.access, access))
          return yield* failure("fenced", "Local machine result has no executor")
        const mapKey = machineKey(assignmentId, operationKey, attempt, machineId)
        const call = (yield* Ref.get(machineCalls)).get(mapKey)
        if (call === undefined) return
        if (
          call.socket !== socket ||
          call.attempt !== attempt ||
          call.requestDigest !== digest ||
          !same(call.access, access)
        )
          return yield* failure("fenced", "Local machine result conflicts with its request")
        yield* settleMachine(
          mapKey,
          call,
          (yield* Clock.currentTimeMillis) >= call.deadlineAtMillis ? machineDeadlineOutcome : outcome,
        )
      }),
    )
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
    yield* machineLock.withPermits(1)(
      Ref.update(machineCalls, (current) => {
        const prefix = `${assignmentId}\u001f${operationKey}\u001f${attempt}\u001f`
        return new Map(Array.from(current).filter(([callKey]) => !callKey.startsWith(prefix)))
      }),
    )
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

  const recoverTerminals = Effect.fn("RunnerGateway.recoverTerminals")(function* () {
    const rows = yield* operations.terminalRecoveryScan.pipe(
      Effect.mapError(() => failure("transport", "Could not inspect Runner terminal receipts")),
    )
    return yield* Effect.forEach(rows, (row) =>
      finalize({
        assignmentId: row.assignmentId,
        operationKey: row.operationKey,
        attempt: row.attempt,
        response: row.frame.response,
        state: row.frame.outcome === "unknown" ? "unknown" : "completed",
      }).pipe(
        Effect.flatMap((result) => settlePending(row.assignmentId, row.operationKey, row.attempt, result)),
        Effect.as<GatewayError | undefined>(undefined),
        Effect.catch((error) => Effect.succeed<GatewayError | undefined>(error)),
      ),
    )
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
        if (frame._tag === "Terminal") {
          if (frame.outcome === "cancelled")
            yield* settleCancelledOperation(assignmentId, attribution.operationKey, attribution.attempt)
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

  const receive = (socket: Socket, frame: SocketFrame) =>
    decode(frame).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.sync(() => socket.close(1007, "malformed")),
        onSuccess: (message) => {
          if (message._tag === "RunnerHello")
            return authority.hello(message.hello).pipe(
              Effect.tap((welcome) =>
                register({
                  socket,
                  access: {
                    version: 1,
                    fence: welcome.fence,
                    leaseEpoch: welcome.leaseEpoch,
                    sessionToken: Redacted.value(welcome.sessionToken),
                  },
                  leaseExpiresAt: welcome.leaseExpiresAt,
                }),
              ),
              Effect.tap((welcome) =>
                Effect.sync(() => {
                  socket.send(
                    encode({
                      _tag: "ExecutorWelcome",
                      welcome: { ...welcome, sessionToken: Redacted.value(welcome.sessionToken) },
                    }),
                  )
                }),
              ),
              Effect.catch((error) => Effect.sync(() => socket.close(1008, error.kind))),
            )
          if (message._tag === "ExecutorReconnect")
            return authority.reconnect(redactAccess(message.access)).pipe(
              Effect.flatMap((welcome) => {
                const session = {
                  socket,
                  access: { ...message.access, leaseEpoch: welcome.leaseEpoch },
                  leaseExpiresAt: welcome.leaseExpiresAt,
                }
                return register(session).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      socket.send(encode({ _tag: "ExecutorReconnected", welcome }))
                    }),
                  ),
                  Effect.andThen(replayPending(session)),
                )
              }),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "ExecutorHeartbeat")
            return authority.heartbeat(redactHeartbeat(message.heartbeat)).pipe(
              Effect.tap((receipt) =>
                register({
                  socket,
                  access: { ...message.heartbeat.access, leaseEpoch: receipt.leaseEpoch },
                  leaseExpiresAt: receipt.leaseExpiresAt,
                }),
              ),
              Effect.tap((receipt) =>
                Effect.sync(() => {
                  socket.send(encode({ _tag: "LeaseReceipt", receipt }))
                }),
              ),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "CellLifecycle")
            return authority.validateAccess(redactAccess(message.access)).pipe(
              Effect.andThen(persistLifecycle(socket, message.access, message.frame)),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "BindingInvoke")
            return authority.validateAccess(redactAccess(message.access)).pipe(
              Effect.andThen(
                receiveBinding(
                  socket,
                  message.access,
                  message.operationKey,
                  message.attempt,
                  message.callId,
                  message.requestDigest,
                  message.request,
                ),
              ),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "MachineResult")
            return authority.validateAccess(redactAccess(message.access)).pipe(
              Effect.andThen(
                receiveMachine(
                  socket,
                  message.access,
                  message.operationKey,
                  message.attempt,
                  message.machineId,
                  message.requestDigest,
                  message.outcome,
                ),
              ),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "RunnerGoodbye")
            return shutdown(socket, message.access).pipe(
              Effect.tap(() => Effect.sync(() => socket.close(1000, "shutdown"))),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag !== "LocalCellResult") return Effect.void
          return authority.validateAccess(redactAccess(message.access)).pipe(
            Effect.andThen(complete(socket, message.access, message.operationKey, message.attempt, message.response)),
            Effect.tap((result) =>
              Effect.sync(() =>
                socket.send(
                  encode({
                    _tag: "LocalCellReceipt",
                    access: result.access ?? message.access,
                    operationKey: message.operationKey,
                    attempt: message.attempt,
                  }),
                ),
              ),
            ),
            Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
          )
        },
      }),
      Effect.asVoid,
    )

  const terminalizeAccepted = Effect.fn("RunnerGateway.terminalizeAccepted")(function* (
    input: OperationIdentity,
    terminalResponse: CellResponse,
    outcome: "failed" | "cancelled",
  ) {
    const current = yield* operations
      .findOperation(input)
      .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
    if (current === undefined) return yield* failure("transport", "Runner operation is unavailable")
    if (current.state === "completed" || current.state === "unknown") {
      if (current.response === null || current.terminalOutcome === null)
        return yield* failure("transport", "Persisted Runner terminal outcome is missing")
      return { response: current.response, outcome: current.terminalOutcome, eventPersisted: true }
    }
    if (current.state === "dispatched") return undefined
    const terminalized = yield* operations
      .terminalizeAccepted(input, terminalResponse, outcome, (result) =>
        store
          .appendEvent({
            eventId: EventId.make(input.operationKey),
            idempotencyKey: IdempotencyKey.make(input.operationKey),
            assignmentId: ExecutorAssignmentId.make(input.assignmentId),
            assignmentGeneration: FencingGeneration.make(String(result.assignmentGeneration)),
            leaseEpoch: AssignmentLeaseEpoch.make(String(result.leaseEpoch)),
            commandSequence: Sequence.make(String(result.commandSequence)),
            event: { _tag: "CellResult", operationKey: input.operationKey, response: terminalResponse },
          })
          .pipe(Effect.mapError((cause) => HostedExecutionOperationsError.make({ message: cause.message }))),
      )
      .pipe(Effect.mapError(() => failure("transport", "Could not persist Runner terminal")))
    if (terminalized === undefined) return undefined
    return finalResult(terminalResponse, outcome)
  })

  const timeoutAccepted = (input: OperationInput) => terminalizeAccepted(input, timeoutResponse, "failed")

  const waitForTerminal = (input: LocalExecuteInput): Effect.Effect<FinalResult, GatewayError> =>
    Effect.gen(function* () {
      yield* recoverTerminals().pipe(Effect.ignore)
      const row = yield* operations
        .findOperation(input)
        .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
      if (row === undefined) return yield* failure("transport", "Runner operation is unavailable")
      if (row.state === "completed" || row.state === "unknown") {
        if (row.response === null || row.terminalOutcome === null)
          return yield* failure("transport", "Persisted Runner terminal outcome is missing")
        const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(input.assignmentId)))
        return finalResult(row.response, row.terminalOutcome, session?.access)
      }
      if ((yield* Clock.currentTimeMillis) >= DateTime.toEpochMillis(DateTime.makeUnsafe(input.deadlineAt))) {
        const timedOut = yield* timeoutAccepted(input)
        if (timedOut !== undefined) return timedOut
        yield* sendCancel(input.assignmentId, input.operationKey, input.attempt)
        return { response: unknownResponse, outcome: "unknown", eventPersisted: false }
      }
      return yield* Effect.sleep("100 millis").pipe(Effect.andThen(waitForTerminal(input)))
    })

  const awaitResult = Effect.fn("RunnerGateway.awaitResult")(function* (
    result: Deferred.Deferred<FinalResult, GatewayError>,
    input: LocalExecuteInput,
  ) {
    const remaining = Math.max(
      0,
      DateTime.toEpochMillis(DateTime.makeUnsafe(input.deadlineAt)) - (yield* Clock.currentTimeMillis),
    )
    return yield* Deferred.await(result).pipe(
      Effect.timeoutOrElse({ duration: remaining, orElse: () => waitForTerminal(input) }),
    )
  })

  const awaitSession = (input: LocalExecuteInput): Effect.Effect<Session | undefined> =>
    Effect.gen(function* () {
      const session = (yield* Ref.get(sessions)).get(input.assignmentId)
      if (session !== undefined) return session
      if ((yield* Clock.currentTimeMillis) >= DateTime.toEpochMillis(DateTime.makeUnsafe(input.deadlineAt)))
        return undefined
      return yield* Effect.sleep("100 millis").pipe(Effect.andThen(awaitSession(input)))
    })

  const execute = Effect.fn("RunnerGateway.execute")(function* (input: LocalExecuteInput) {
    yield* recoverTerminals().pipe(Effect.ignore)
    const durable = yield* prepare(input)
    const request = {
      ...input,
      admittedAt: durable.admittedAt,
      deadlineAt: durable.deadlineAt,
    }
    const pendingKey = key(request.assignmentId, request.operationKey, request.attempt)
    const existingPending = yield* gatewayLock.withPermits(1)(
      Ref.get(pending).pipe(Effect.map((current) => current.get(pendingKey))),
    )
    if (existingPending !== undefined) {
      if (existingPending.code !== request.code)
        return yield* failure("fenced", "Runner operation identity conflicts with different code")
      return yield* awaitResult(existingPending.result, request)
    }

    if (durable.state === "completed" || durable.state === "unknown") {
      if (durable.response === null || durable.terminalOutcome === null)
        return yield* failure("transport", "Persisted Runner terminal outcome is missing")
      const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(request.assignmentId)))
      const result: FinalResult = {
        response: durable.response,
        outcome: durable.terminalOutcome,
        eventPersisted: true as const,
      }
      if (session !== undefined) return { ...result, access: session.access }
      return result
    }

    const session = yield* awaitSession(request)
    if (session === undefined) return yield* waitForTerminal(request)
    const workspace = yield* authority
      .workspaceIdentity(redactAccess(session.access))
      .pipe(Effect.mapError((error) => failure("fenced", error.message)))
    const setup = yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const currentPending = yield* Ref.get(pending).pipe(Effect.map((current) => current.get(pendingKey)))
        if (currentPending !== undefined) {
          if (currentPending.code !== request.code)
            return yield* failure("fenced", "Runner operation identity conflicts with different code")
          return { existing: currentPending } as const
        }
        const currentSession = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(request.assignmentId)))
        if (
          currentSession === undefined ||
          currentSession.socket !== session.socket ||
          !same(currentSession.access, session.access)
        )
          return yield* failure("disconnected", "Runner disconnected before dispatch")
        yield* authority
          .validateAccess(redactAccess(currentSession.access))
          .pipe(Effect.mapError((error) => failure("fenced", error.message)))
        const currentOperation = yield* prepare(request)
        if (currentOperation.state === "accepted")
          yield* claimDispatch({
            session: currentSession,
            operationKey: request.operationKey,
            attempt: Number(currentOperation.attempt),
          })
        else if (
          currentOperation.state !== "dispatched" ||
          currentOperation.dispatchedGeneration !== currentSession.access.fence.assignmentGeneration ||
          currentOperation.dispatchedExecutorInstanceId !== currentSession.access.fence.executorId ||
          currentOperation.dispatchedProcessIncarnation !== currentSession.access.fence.processIncarnation
        )
          return yield* failure("fenced", "Runner operation was dispatched to a different executor")
        const result = yield* Deferred.make<FinalResult, GatewayError>()
        const current: Pending = {
          assignmentId: request.assignmentId,
          operationKey: request.operationKey,
          attempt: Number(currentOperation.attempt),
          code: request.code,
          request,
          socket: currentSession.socket,
          access: currentSession.access,
          result,
          bindings: request.bindings,
          bindingCalls: yield* Ref.make(new Map()),
          bindingLock: yield* Semaphore.make(1),
          nextMachineOrdinal: yield* Ref.make(0),
        }
        yield* Ref.update(pending, (values) => new Map(values).set(pendingKey, current))
        yield* Effect.try({
          try: () => {
            currentSession.socket.send(
              encode({
                _tag: "CellExecute",
                request: {
                  access: currentSession.access,
                  operationKey: request.operationKey,
                  workspaceId: workspace,
                  sessionId: request.sessionId,
                  threadId: request.threadId,
                  turnId: request.turnId,
                  runId: request.runId,
                  toolCallId: request.toolCallId,
                  code: request.code,
                  rootRunId: request.rootRunId,
                  attempt: current.attempt,
                  replayPolicy: request.replayPolicy,
                  admittedAt: request.admittedAt,
                  deadlineAt: request.deadlineAt,
                  bindings: request.bindings.manifest,
                },
              }),
            )
          },
          catch: () => undefined,
        }).pipe(Effect.ignore)
        return { current } as const
      }),
    )
    if ("existing" in setup) return yield* awaitResult(setup.existing.result, request)
    return yield* awaitResult(setup.current.result, request).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.void
          : retirePending(request.assignmentId, request.operationKey, request.attempt, setup.current).pipe(
              Effect.ignore,
            ),
      ),
    )
  })

  const cancel = Effect.fn("RunnerGateway.cancel")(function* (input: OperationIdentity) {
    const row = yield* operations
      .findOperation(input)
      .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
    if (row === undefined) return yield* failure("transport", "Runner operation is unavailable")
    const digest = yield* identifyOperation(input)
    if (!matchesOperation(input, row, digest))
      return yield* failure("fenced", "Runner operation key conflicts with a different request")
    const accepted = yield* terminalizeAccepted(input, cancelledResponse, "cancelled")
    if (accepted !== undefined) return accepted
    const pendingKey = key(input.assignmentId, input.operationKey, input.attempt)
    const awaitTerminal = (sentTo?: Socket): Effect.Effect<FinalResult, GatewayError> =>
      Effect.gen(function* () {
        yield* recoverTerminals().pipe(Effect.ignore)
        const current = yield* operations
          .findOperation(input)
          .pipe(Effect.mapError(() => failure("transport", "Could not read Runner operation")))
        if (current === undefined) return yield* failure("transport", "Runner operation is unavailable")
        if (current.state === "completed" || current.state === "unknown") {
          if (current.response === null || current.terminalOutcome === null)
            return yield* failure("transport", "Persisted Runner terminal outcome is missing")
          const session = (yield* Ref.get(sessions)).get(input.assignmentId)
          return finalResult(current.response, current.terminalOutcome, session?.access)
        }
        if (current.state === "accepted") {
          const terminal = yield* terminalizeAccepted(input, cancelledResponse, "cancelled")
          if (terminal !== undefined) return terminal
        }
        const session = (yield* Ref.get(sessions)).get(input.assignmentId)
        const nextSocket = session?.socket ?? sentTo
        if (session !== undefined && session.socket !== sentTo) {
          yield* authority
            .validateAccess(redactAccess(session.access))
            .pipe(Effect.mapError((error) => failure("fenced", error.message)))
          yield* Effect.try({
            try: () =>
              session.socket.send(
                encode({
                  _tag: "CellCancel",
                  access: session.access,
                  operationKey: input.operationKey,
                  attempt: input.attempt,
                }),
              ),
            catch: () => failure("transport", "Could not cancel Runner operation"),
          })
        }
        const pendingOperation = (yield* Ref.get(pending)).get(pendingKey)
        if (pendingOperation !== undefined) {
          const completed = yield* Effect.raceFirst(
            Deferred.await(pendingOperation.result).pipe(
              Effect.map((result) => ({ _tag: "Completed" as const, result })),
            ),
            Effect.sleep("100 millis").pipe(Effect.as({ _tag: "Polling" as const })),
          )
          if (completed._tag === "Completed") return completed.result
        } else yield* Effect.sleep("100 millis")
        return yield* awaitTerminal(nextSocket)
      })
    return yield* awaitTerminal()
  })

  const machine = Effect.fn("RunnerGateway.machine")(function* (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    request: MachineBindings.Request,
  ) {
    const pendingOperation = (yield* Ref.get(pending)).get(key(assignmentId, operationKey, attempt))
    const session = (yield* Ref.get(sessions)).get(assignmentId)
    if (pendingOperation === undefined || session === undefined)
      return yield* failure("disconnected", "Local cell authority is no longer available")
    const ordinal = yield* Ref.getAndUpdate(pendingOperation.nextMachineOrdinal, (current) => current + 1)
    const machineId = `${pendingOperation.request.toolCallId}:${ordinal}`
    const digest = yield* requestDigest(encodeMachineRequest(request))
    const result = yield* Deferred.make<MachineBindings.Outcome>()
    const mapKey = machineKey(assignmentId, operationKey, attempt, machineId)
    const deadlineAtMillis = DateTime.toEpochMillis(DateTime.makeUnsafe(pendingOperation.request.deadlineAt))
    const candidate: MachineCall = {
      assignmentId,
      operationKey,
      attempt,
      machineId,
      requestDigest: digest,
      request,
      socket: session.socket,
      access: session.access,
      deadlineAtMillis,
      result,
    }
    const admitted = yield* machineLock.withPermits(1)(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const current = yield* Ref.get(machineCalls)
          const known = current.get(mapKey)
          if ((yield* Clock.currentTimeMillis) >= deadlineAtMillis) {
            if (known !== undefined) {
              yield* Deferred.succeed(known.result, machineDeadlineOutcome)
              yield* Ref.set(machineCalls, new Map(Array.from(current).filter(([currentKey]) => currentKey !== mapKey)))
            }
            return { call: undefined, sent: true } as const
          }
          const call = known ?? candidate
          if (known !== undefined) return { call, sent: true } as const
          yield* Ref.set(machineCalls, new Map(current).set(mapKey, candidate))
          const sent = yield* Effect.try({
            try: () =>
              session.socket.send(
                encode({
                  _tag: "MachineExecute",
                  access: session.access,
                  operationKey,
                  attempt,
                  machineId,
                  requestDigest: digest,
                  request,
                }),
              ),
            catch: () => false,
          }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
          return { call, sent } as const
        }),
      ),
    )
    const call = admitted.call
    if (call === undefined) return machineDeadlineOutcome
    if (call.requestDigest !== digest)
      return { _tag: "Fenced" as const, message: "Local machine call id conflicts with a different request" }
    if (!admitted.sent)
      return yield* settleMachine(mapKey, call, {
        _tag: "Unknown",
        message: "Local machine delivery is uncertain",
      })
    const remaining = Math.max(0, call.deadlineAtMillis - (yield* Clock.currentTimeMillis))
    return yield* Deferred.await(call.result).pipe(
      Effect.timeoutOrElse({
        duration: remaining,
        orElse: () => settleMachine(mapKey, call, machineDeadlineOutcome),
      }),
    )
  })

  const pollAccepted = Effect.fn("RunnerGateway.pollAccepted")(function* () {
    const failures = (yield* recoverTerminals()).filter((error): error is GatewayError => error !== undefined)
    const first = failures[0]
    if (first === undefined) return
    yield* Effect.logError("runner-recovery.failed").pipe(
      Effect.annotateLogs({
        "rika.error.kind": first.kind,
        "rika.error.message": first.message,
        "rika.recovery.failures": failures.length,
      }),
    )
  })

  const pollTick = Effect.sleep("1 second").pipe(
    Effect.andThen(pollAccepted()),
    Effect.catch((error) =>
      Effect.logError("runner-recovery.poll-failed").pipe(
        Effect.annotateLogs({ "rika.error.kind": error.kind, "rika.error.message": error.message }),
      ),
    ),
  )
  yield* Effect.forever(pollTick).pipe(Effect.forkScoped)

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

  return { receive, disconnected, active, execute, cancel, machine }
})

export const makeRunnerGateway = Effect.fn("RunnerGateway.makeLive")(function* (
  authority: RunnerExecutorAuthority,
  toolPolicy: HostedToolPolicyService,
) {
  const context = yield* Layer.build(hostedExecutionOperationsLayer)
  return yield* makeRunnerGatewayWithOperations(authority, toolPolicy).pipe(Effect.provideContext(context))
})
