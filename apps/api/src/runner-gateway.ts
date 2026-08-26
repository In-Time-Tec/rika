import * as PgClient from "@effect/sql-pg/PgClient"
import type * as MachineBindings from "@rika/kernel/machine-bindings"
import {
  ApiMessage,
  CellLifecycleFrame as CellLifecycleFrameSchema,
  CellResponse as CellResponseSchema,
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
} from "./executor-gateway"
import { invokeAdmittedTool, type HostedToolPolicyService } from "./hosted-tool-policy"
import type { RunnerExecutorAuthority } from "./runner-executor"
import type { Socket } from "./executor-gateway"

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

interface OperationRow {
  readonly requestDigest: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly threadId: string
  readonly turnId: string
  readonly runId: string
  readonly rootRunId: string
  readonly toolCallId: string
  readonly code: string
  readonly attempt: string
  readonly replayPolicy: "pure" | "provider-idempotent" | "never"
  readonly admittedAt: string | null
  readonly deadlineAt: string
  readonly state: "accepted" | "dispatched" | "completed" | "unknown"
  readonly dispatchedGeneration: string | null
  readonly dispatchedLeaseEpoch: string | null
  readonly dispatchedExecutorInstanceId: string | null
  readonly dispatchedProcessIncarnation: string | null
  readonly response: unknown
  readonly terminalOutcome: "completed" | "failed" | "cancelled" | "unknown" | null
}

type LocalExecuteInput = OperationInput & {
  readonly bindings: BindingAuthority
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ApiMessage))
const decodeResponse = Schema.decodeUnknownEffect(CellResponseSchema)
const equivalentResponse = Schema.toEquivalence(CellResponseSchema)
const decodeLifecycle = Schema.decodeUnknownEffect(CellLifecycleFrameSchema)
const equivalentLifecycle = Schema.toEquivalence(CellLifecycleFrameSchema)
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

export const makeRunnerGateway = Effect.fn("RunnerGateway.make")(function* (
  authority: RunnerExecutorAuthority,
  toolPolicy: HostedToolPolicyService,
) {
  const sql = yield* PgClient.PgClient
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

  const operation = (assignmentId: string, operationKey: string, attempt: number) =>
    sql<OperationRow>`SELECT request_digest AS "requestDigest", workspace_id AS "workspaceId",
      session_id AS "sessionId", thread_id AS "threadId", turn_id AS "turnId", run_id AS "runId",
      root_run_id AS "rootRunId", tool_call_id AS "toolCallId", code, attempt::text AS attempt,
      replay_policy AS "replayPolicy",
      admitted_at AS "admittedAt",
      to_char(deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deadlineAt", state,
      dispatched_generation::text AS "dispatchedGeneration",
      dispatched_lease_epoch::text AS "dispatchedLeaseEpoch",
      dispatched_executor_instance_id AS "dispatchedExecutorInstanceId",
      dispatched_process_incarnation AS "dispatchedProcessIncarnation",
      response, terminal_outcome AS "terminalOutcome"
      FROM rika_hosted_executor_operations
      WHERE assignment_id = ${assignmentId} AND operation_key = ${operationKey} AND attempt = ${attempt}::bigint`

  const lockedOperation = (assignmentId: string, operationKey: string, attempt: number) =>
    sql<OperationRow>`SELECT request_digest AS "requestDigest", workspace_id AS "workspaceId",
      session_id AS "sessionId", thread_id AS "threadId", turn_id AS "turnId", run_id AS "runId",
      root_run_id AS "rootRunId", tool_call_id AS "toolCallId", code, attempt::text AS attempt,
      replay_policy AS "replayPolicy",
      admitted_at AS "admittedAt",
      to_char(deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "deadlineAt", state,
      dispatched_generation::text AS "dispatchedGeneration",
      dispatched_lease_epoch::text AS "dispatchedLeaseEpoch",
      dispatched_executor_instance_id AS "dispatchedExecutorInstanceId",
      dispatched_process_incarnation AS "dispatchedProcessIncarnation",
      response, terminal_outcome AS "terminalOutcome"
      FROM rika_hosted_executor_operations
      WHERE assignment_id = ${assignmentId} AND operation_key = ${operationKey} AND attempt = ${attempt}::bigint
      FOR UPDATE`

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

  const matchesOperation = (input: OperationIdentity, row: OperationRow, digest: string) =>
    row.requestDigest === digest &&
    row.workspaceId === input.workspaceId &&
    row.sessionId === input.sessionId &&
    row.threadId === input.threadId &&
    row.turnId === input.turnId &&
    row.runId === input.runId &&
    row.rootRunId === input.rootRunId &&
    row.toolCallId === input.toolCallId &&
    row.code === input.code &&
    Number(row.attempt) === input.attempt &&
    row.replayPolicy === input.replayPolicy

  const prepare = Effect.fn("RunnerGateway.prepare")(function* (input: OperationInput) {
    const digest = yield* identifyOperation(input)
    yield* sql`INSERT INTO rika_hosted_executor_operations
      (assignment_id, owner_id, operation_key, request_digest, workspace_id, session_id, thread_id, turn_id,
       run_id, root_run_id, tool_call_id, code, attempt, replay_policy, admitted_at, deadline_at, state)
      SELECT assignment.id, assignment.owner_id, ${input.operationKey}, ${digest}, ${input.workspaceId},
        ${input.sessionId}, ${input.threadId}, ${input.turnId}, ${input.runId}, ${input.rootRunId},
        ${input.toolCallId}, ${input.code}, ${input.attempt}, ${input.replayPolicy}, ${input.admittedAt}, ${input.deadlineAt}, 'accepted'
      FROM rika_hosted_executor_assignments assignment
      WHERE assignment.id = ${input.assignmentId}
      ON CONFLICT (assignment_id, operation_key, attempt) DO NOTHING`.pipe(
      Effect.mapError(() => failure("transport", "Could not persist Runner operation")),
    )
    const row = (yield* operation(input.assignmentId, input.operationKey, input.attempt).pipe(
      Effect.mapError(() => failure("transport", "Could not read Runner operation")),
    ))[0]
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
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const assignmentRows = yield* sql<{ readonly id: string }>`SELECT assignment.id
            FROM rika_hosted_executor_assignments assignment
            JOIN rika_hosted_runner_admissions admission
              ON admission.assignment_id = assignment.id
              AND admission.owner_id = assignment.owner_id
              AND admission.generation = assignment.generation
              AND admission.device_id = assignment.provider_instance_id
              AND admission.process_incarnation = assignment.process_incarnation
              AND admission.consumed_at IS NOT NULL
              AND admission.revoked_at IS NULL
            JOIN rika_hosted_workspace_capability_admissions capability_admission
              ON capability_admission.assignment_id = assignment.id
              AND capability_admission.thread_id = assignment.thread_id
              AND capability_admission.turn_id = (
                SELECT operation.turn_id FROM rika_hosted_executor_operations operation
                WHERE operation.assignment_id = ${input.session.access.fence.assignmentId}
                  AND operation.operation_key = ${input.operationKey} AND operation.attempt = ${input.attempt}::bigint
              )
              AND capability_admission.assignment_generation = assignment.generation
              AND capability_admission.environment_digest = assignment.capability_snapshot->>'environmentDigest'
            JOIN rika_cli_registration registration
              ON registration.client_id = admission.client_id
              AND registration.device_id::text = admission.device_id
              AND registration.user_id = admission.user_id
              AND registration.revoked_at IS NULL
            JOIN rika_hosted_owners owner_record
              ON owner_record.id = assignment.owner_id
            WHERE assignment.id = ${input.session.access.fence.assignmentId}
              AND (
                (owner_record.kind = 'personal' AND owner_record.user_id = admission.user_id)
                OR (owner_record.kind = 'organization' AND EXISTS (
                  SELECT 1 FROM member membership
                  WHERE membership.organization_id = owner_record.organization_id
                    AND membership.user_id = admission.user_id
                ))
              )
              AND assignment.lifecycle = 'active'
              AND assignment.capability_generation = assignment.generation
              AND assignment.generation = ${input.session.access.fence.assignmentGeneration}::bigint
              AND assignment.lease_epoch = ${input.session.access.leaseEpoch}::bigint
              AND assignment.lease_expires_at > clock_timestamp()
              AND assignment.provider_instance_id = ${input.session.access.fence.instanceId}
              AND assignment.executor_instance_id = ${input.session.access.fence.executorId}
              AND assignment.process_incarnation = ${input.session.access.fence.processIncarnation}
              AND assignment.session_digest = ${sessionDigest}
            FOR UPDATE`.pipe(Effect.mapError(() => failure("transport", "Could not claim Runner fence")))
          if (assignmentRows[0] === undefined) return yield* failure("fenced", "Runner fence is no longer current")
          const rows = yield* lockedOperation(
            input.session.access.fence.assignmentId,
            input.operationKey,
            input.attempt,
          ).pipe(Effect.mapError(() => failure("transport", "Could not lock Runner operation")))
          const operationRow = rows[0]
          if (operationRow === undefined) return yield* failure("transport", "Runner operation is unavailable")
          if (operationRow.state !== "accepted")
            return yield* failure("fenced", "Runner operation changed before dispatch")
          const updated = yield* sql`UPDATE rika_hosted_executor_operations SET
            state = 'dispatched', dispatched_generation = ${input.session.access.fence.assignmentGeneration}::bigint,
            dispatched_lease_epoch = ${input.session.access.leaseEpoch}::bigint,
            dispatched_executor_instance_id = ${input.session.access.fence.executorId},
            dispatched_process_incarnation = ${input.session.access.fence.processIncarnation},
            updated_at = clock_timestamp()
            WHERE assignment_id = ${input.session.access.fence.assignmentId}
              AND operation_key = ${input.operationKey} AND attempt = ${input.attempt}::bigint
              AND state = 'accepted' RETURNING operation_key`.pipe(
            Effect.mapError(() => failure("transport", "Could not persist Runner dispatch")),
          )
          if (updated[0] === undefined) return yield* failure("fenced", "Runner operation changed before dispatch")
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => Effect.fail(failure("transport", "Could not claim Runner fence"))))
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
    const operations = yield* sql<{
      readonly operationKey: string
      readonly attempt: string
      readonly afterCursor: string
    }>`SELECT operation.operation_key AS "operationKey", operation.attempt::text AS attempt,
        COALESCE(MAX(frame.cursor), 0)::text AS "afterCursor"
      FROM rika_hosted_executor_operations operation
      LEFT JOIN rika_hosted_executor_operation_frames frame
        ON frame.assignment_id = operation.assignment_id AND frame.operation_key = operation.operation_key
        AND frame.attempt = operation.attempt
      WHERE operation.assignment_id = ${session.access.fence.assignmentId} AND operation.state = 'dispatched'
      GROUP BY operation.operation_key, operation.attempt
      ORDER BY operation.operation_key, operation.attempt`.pipe(
      Effect.mapError(() => failure("transport", "Could not load Runner replay queue")),
    )
    for (const queued of operations)
      session.socket.send(
        encode({
          _tag: "CellReplay",
          access: session.access,
          operationKey: queued.operationKey,
          attempt: Number(queued.attempt),
          afterCursor: Number(queued.afterCursor),
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
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* lockedOperation(assignmentId, input.operationKey, input.attempt).pipe(
            Effect.mapError(() => failure("transport", "Could not lock Runner operation")),
          )
          const current = rows[0]
          if (current === undefined) return yield* failure("transport", "Runner operation is unavailable")
          if (Number(current.attempt) !== input.attempt)
            return yield* failure("fenced", "Runner operation attempt is stale")
          if (current.state === "completed" || current.state === "unknown") {
            const previous = yield* decodeResponse(current.response).pipe(
              Effect.mapError(() => failure("transport", "Persisted Runner response is invalid")),
            )
            if (current.terminalOutcome === null)
              return yield* failure("transport", "Persisted Runner terminal outcome is missing")
            if (!equivalentResponse(previous, input.response)) {
              if (input.state === "unknown" || current.state === "unknown")
                return {
                  ...(input.access === undefined ? {} : { access: input.access }),
                  response: previous,
                  outcome: current.terminalOutcome,
                  eventPersisted: true as const,
                }
              return yield* failure("fenced", "Runner operation already has a different terminal result")
            }
            return {
              ...(input.access === undefined ? {} : { access: input.access }),
              response: previous,
              outcome: current.terminalOutcome,
              eventPersisted: true as const,
            }
          }
          if (current.state !== "dispatched") return yield* failure("fenced", "Runner operation was not dispatched")
          if (
            current.dispatchedGeneration === null ||
            current.dispatchedLeaseEpoch === null ||
            current.dispatchedExecutorInstanceId === null ||
            current.dispatchedProcessIncarnation === null
          )
            return yield* failure("fenced", "Runner operation has an incomplete dispatch fence")
          const persistedFence = {
            assignmentGeneration: current.dispatchedGeneration,
            leaseEpoch: current.dispatchedLeaseEpoch,
            executorInstanceId: current.dispatchedExecutorInstanceId,
            processIncarnation: current.dispatchedProcessIncarnation,
          }
          const terminalRows = yield* sql<{ readonly frame: unknown }>`SELECT frame
            FROM rika_hosted_executor_operation_frames
            WHERE assignment_id = ${assignmentId} AND operation_key = ${input.operationKey}
              AND attempt = ${input.attempt}::bigint AND kind = 'Terminal'
            LIMIT 1`.pipe(Effect.mapError(() => failure("transport", "Could not inspect Runner terminal receipt")))
          const terminal =
            terminalRows[0] === undefined
              ? undefined
              : yield* decodeLifecycle(terminalRows[0].frame).pipe(
                  Effect.mapError(() => failure("transport", "Persisted Runner terminal receipt is invalid")),
                )
          const terminalFrame = terminal?._tag === "Terminal" ? terminal : undefined
          const terminalResponse = terminalFrame?.response
          let resolvedState: typeof input.state | "unknown" | "completed" = input.state
          if (terminalFrame !== undefined) resolvedState = terminalFrame.outcome === "unknown" ? "unknown" : "completed"
          const resolvedResponse = terminalResponse ?? input.response
          const resolvedOutcome = terminalFrame?.outcome ?? "unknown"
          if (
            resolvedState === "completed" &&
            terminalResponse === undefined &&
            (input.access === undefined ||
              input.access.fence.assignmentId !== assignmentId ||
              String(input.access.fence.assignmentGeneration) !== persistedFence.assignmentGeneration ||
              input.access.fence.executorId !== persistedFence.executorInstanceId ||
              input.access.fence.processIncarnation !== persistedFence.processIncarnation)
          )
            return yield* failure("fenced", "Runner completion does not match the dispatched fence")
          const expectedFence = input.dispatchedFence ?? persistedFence
          if (
            persistedFence.assignmentGeneration !== expectedFence.assignmentGeneration ||
            persistedFence.leaseEpoch !== expectedFence.leaseEpoch ||
            persistedFence.executorInstanceId !== expectedFence.executorInstanceId ||
            persistedFence.processIncarnation !== expectedFence.processIncarnation
          )
            return yield* failure("fenced", "Runner operation was not dispatched to this fence")
          const updated = yield* sql`UPDATE rika_hosted_executor_operations SET
              state = ${resolvedState}, response = ${sql.json(resolvedResponse)},
              terminal_outcome = ${resolvedOutcome},
              updated_at = clock_timestamp()
              WHERE assignment_id = ${assignmentId} AND operation_key = ${input.operationKey}
                AND attempt = ${input.attempt}::bigint AND state = 'dispatched'
                AND dispatched_generation = ${expectedFence.assignmentGeneration}::bigint
                AND dispatched_lease_epoch = ${expectedFence.leaseEpoch}::bigint
                AND dispatched_executor_instance_id = ${expectedFence.executorInstanceId}
                AND dispatched_process_incarnation = ${expectedFence.processIncarnation}
              RETURNING operation_key`.pipe(
            Effect.mapError(() => failure("transport", "Could not persist Runner result")),
          )
          if (updated[0] === undefined) return yield* failure("fenced", "Runner result lost its fence")
          const commands = yield* sql<{ readonly sequence: string }>`SELECT sequence::text AS sequence
          FROM rika_hosted_thread_commands
          WHERE thread_id = ${current.threadId} AND turn_id = ${current.turnId}
          LIMIT 1`.pipe(Effect.mapError(() => failure("transport", "Runner command is unavailable")))
          const command = commands[0]
          if (command === undefined) return yield* failure("transport", "Runner command is unavailable")
          const event = {
            eventId: EventId.make(input.operationKey),
            idempotencyKey: IdempotencyKey.make(input.operationKey),
            assignmentId: ExecutorAssignmentId.make(assignmentId),
            assignmentGeneration: FencingGeneration.make(expectedFence.assignmentGeneration),
            leaseEpoch: AssignmentLeaseEpoch.make(
              resolvedState === "completed" && input.access !== undefined
                ? String(input.access.leaseEpoch)
                : expectedFence.leaseEpoch,
            ),
            commandSequence: Sequence.make(command.sequence),
            event: { _tag: "CellResult", operationKey: input.operationKey, response: resolvedResponse },
          }
          if (recovering)
            yield* store
              .appendRecoveredEvent({
                ...event,
                assignmentGeneration: FencingGeneration.make(expectedFence.assignmentGeneration),
                leaseEpoch: AssignmentLeaseEpoch.make(expectedFence.leaseEpoch),
                executorInstanceId: expectedFence.executorInstanceId,
                processIncarnation: expectedFence.processIncarnation,
              })
              .pipe(Effect.mapError(() => failure("transport", "Could not persist Runner recovery event")))
          else
            yield* store
              .appendEvent(event)
              .pipe(Effect.mapError(() => failure("transport", "Could not persist Runner event")))
          return {
            ...(input.access === undefined ? {} : { access: input.access }),
            response: resolvedResponse,
            outcome: resolvedOutcome,
            eventPersisted: true as const,
          }
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => Effect.fail(failure("transport", "Could not persist Runner result"))))
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
    const rows = yield* sql<{
      readonly assignmentId: string
      readonly operationKey: string
      readonly attempt: string
      readonly frame: unknown
    }>`SELECT operation.assignment_id AS "assignmentId", operation.operation_key AS "operationKey",
        operation.attempt::text AS attempt, receipt.frame
      FROM rika_hosted_executor_operations operation
      JOIN rika_hosted_executor_operation_frames receipt
        ON receipt.assignment_id = operation.assignment_id
        AND receipt.operation_key = operation.operation_key
        AND receipt.attempt = operation.attempt
        AND receipt.kind = 'Terminal'
      WHERE operation.state = 'dispatched'
      ORDER BY operation.updated_at, operation.operation_key
      LIMIT 32`.pipe(Effect.mapError(() => failure("transport", "Could not inspect Runner terminal receipts")))
    return yield* Effect.forEach(rows, (row) =>
      decodeLifecycle(row.frame).pipe(
        Effect.mapError(() => failure("transport", "Persisted Runner terminal receipt is invalid")),
        Effect.flatMap((frame) =>
          frame._tag !== "Terminal"
            ? Effect.fail(failure("transport", "Persisted Runner terminal receipt is invalid"))
            : finalize({
                assignmentId: row.assignmentId,
                operationKey: row.operationKey,
                attempt: Number(row.attempt),
                response: frame.response,
                state: frame.outcome === "unknown" ? "unknown" : "completed",
              }),
        ),
        Effect.flatMap((result) => settlePending(row.assignmentId, row.operationKey, Number(row.attempt), result)),
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
    const persisted = (yield* operation(access.fence.assignmentId, operationKey, attempt).pipe(
      Effect.mapError(() => failure("transport", "Could not read Runner operation")),
    ))[0]
    if (persisted === undefined) return yield* failure("fenced", "Runner operation is unavailable")
    if (persisted.state === "completed" || persisted.state === "unknown") {
      const canonical = yield* decodeResponse(persisted.response).pipe(
        Effect.mapError(() => failure("transport", "Persisted Runner response is invalid")),
      )
      if (persisted.terminalOutcome === null)
        return yield* failure("transport", "Persisted Runner terminal outcome is missing")
      if (persisted.state === "completed" && !equivalentResponse(canonical, response))
        return yield* failure("fenced", "Runner operation already has a different terminal result")
      return {
        access,
        response: canonical,
        outcome: persisted.terminalOutcome,
        eventPersisted: true as const,
      }
    }
    const terminalRows = yield* sql<{ readonly frame: unknown }>`SELECT frame
      FROM rika_hosted_executor_operation_frames
      WHERE assignment_id = ${access.fence.assignmentId}
        AND operation_key = ${operationKey}
        AND attempt = ${attempt}::bigint
        AND kind = 'Terminal'`.pipe(
      Effect.mapError(() => failure("transport", "Could not read Runner terminal receipt")),
    )
    const terminal = terminalRows[0]
    if (terminal === undefined) return yield* failure("fenced", "Runner result arrived before its terminal receipt")
    const terminalFrame = yield* decodeLifecycle(terminal.frame).pipe(
      Effect.mapError(() => failure("transport", "Persisted Runner terminal receipt is invalid")),
    )
    if (terminalFrame._tag !== "Terminal" || !equivalentResponse(terminalFrame.response, response))
      return yield* failure("fenced", "Runner result conflicts with its terminal receipt")
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
        const disposition = yield* sql.withTransaction(
          Effect.gen(function* () {
            const persisted = (yield* lockedOperation(assignmentId, attribution.operationKey, attribution.attempt).pipe(
              Effect.mapError(() => failure("transport", "Could not lock Runner lifecycle operation")),
            ))[0]
            if (persisted === undefined)
              return yield* failure("fenced", "Runner lifecycle operation attribution is invalid")
            const invalidAttribution = (
              [
                ["attempt", Number(persisted.attempt) === attribution.attempt],
                ["workspace", persisted.workspaceId === attribution.workspaceId],
                ["session", persisted.sessionId === attribution.sessionId],
                ["thread", persisted.threadId === attribution.threadId],
                ["turn", persisted.turnId === attribution.turnId],
                ["run", persisted.runId === attribution.runId],
                ["root run", persisted.rootRunId === attribution.rootRunId],
                ["tool call", persisted.toolCallId === attribution.toolCallId],
              ] as const
            ).find(([, valid]) => !valid)?.[0]
            if (invalidAttribution !== undefined)
              return yield* failure("fenced", `Runner lifecycle ${invalidAttribution} attribution is invalid`)
            const stored = yield* sql<{ readonly frame: unknown }>`SELECT frame
              FROM rika_hosted_executor_operation_frames
              WHERE assignment_id = ${assignmentId} AND operation_key = ${attribution.operationKey}
                AND attempt = ${attribution.attempt}::bigint
              ORDER BY cursor`.pipe(
              Effect.mapError(() => failure("transport", "Could not read Runner lifecycle frames")),
            )
            const known = yield* Effect.forEach(stored, (row) =>
              decodeLifecycle(row.frame).pipe(
                Effect.mapError(() => failure("transport", "Persisted Runner lifecycle frame is invalid")),
              ),
            )
            const existing = known.find((retained) => retained.cursor === frame.cursor)
            if (existing !== undefined) {
              if (!equivalentLifecycle(existing, frame))
                return yield* failure("fenced", "Runner lifecycle cursor has different content")
              return persisted.state === "completed" || persisted.state === "unknown"
                ? ("already-terminal" as const)
                : ("appended" as const)
            }
            if (persisted.state === "completed" || persisted.state === "unknown") return "already-terminal" as const
            if (
              frame.cursor !== known.length + 1 ||
              known.some((retained) => retained._tag === "Terminal") ||
              (frame.cursor === 1 && frame._tag !== "Accepted") ||
              (frame.cursor === 2 && frame._tag !== "Started") ||
              (frame.cursor > 2 && frame._tag !== "Output" && frame._tag !== "Terminal") ||
              (frame._tag === "Output" && known.filter((retained) => retained._tag === "Output").length >= 16)
            )
              return yield* failure("fenced", "Runner lifecycle sequence is invalid")
            if (persisted.state !== "dispatched") return yield* failure("fenced", "Runner operation was not dispatched")
            yield* sql`INSERT INTO rika_hosted_executor_operation_frames
              (assignment_id, operation_key, attempt, cursor, kind, frame)
              VALUES (${assignmentId}, ${attribution.operationKey}, ${attribution.attempt},
                ${frame.cursor}, ${frame._tag}, ${sql.json(frame)})`.pipe(
              Effect.mapError(() => failure("transport", "Could not persist Runner lifecycle frame")),
            )
            return "appended" as const
          }),
        )
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

  const receive = (socket: Socket, frame: unknown) =>
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
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* lockedOperation(input.assignmentId, input.operationKey, input.attempt).pipe(
            Effect.mapError(() => failure("transport", "Could not lock Runner operation")),
          )
          const row = rows[0]
          if (row === undefined) return yield* failure("transport", "Runner operation is unavailable")
          if (row.state === "completed" || row.state === "unknown") {
            const response = yield* decodeResponse(row.response).pipe(
              Effect.mapError(() => failure("transport", "Persisted Runner response is invalid")),
            )
            if (row.terminalOutcome === null)
              return yield* failure("transport", "Persisted Runner terminal outcome is missing")
            return {
              response,
              outcome: row.terminalOutcome,
              eventPersisted: true,
            } satisfies FinalResult
          }
          if (row.state === "dispatched") return undefined
          const updated = yield* sql`UPDATE rika_hosted_executor_operations SET
            state = 'completed', response = ${sql.json(terminalResponse)}, terminal_outcome = ${outcome},
            updated_at = clock_timestamp()
            WHERE assignment_id = ${input.assignmentId} AND operation_key = ${input.operationKey}
              AND attempt = ${input.attempt}::bigint AND state = 'accepted'
            RETURNING operation_key`.pipe(
            Effect.mapError(() => failure("transport", "Could not persist Runner terminal")),
          )
          if (updated[0] === undefined) return undefined
          const commands = yield* sql<{ readonly sequence: string }>`SELECT sequence::text AS sequence
            FROM rika_hosted_thread_commands
            WHERE thread_id = ${row.threadId} AND turn_id = ${row.turnId}
            LIMIT 1`.pipe(Effect.mapError(() => failure("transport", "Runner command is unavailable")))
          const command = commands[0]
          if (command === undefined) return yield* failure("transport", "Runner command is unavailable")
          const assignmentRows = yield* sql<{
            readonly generation: string
            readonly leaseEpoch: string
          }>`SELECT generation::text AS generation, lease_epoch::text AS "leaseEpoch"
            FROM rika_hosted_executor_assignments
            WHERE id = ${input.assignmentId} AND lease_epoch IS NOT NULL
            FOR SHARE`.pipe(Effect.mapError(() => failure("transport", "Runner assignment is unavailable")))
          const assignment = assignmentRows[0]
          if (assignment === undefined) return yield* failure("transport", "Runner assignment is unavailable")
          yield* store
            .appendEvent({
              eventId: EventId.make(input.operationKey),
              idempotencyKey: IdempotencyKey.make(input.operationKey),
              assignmentId: ExecutorAssignmentId.make(input.assignmentId),
              assignmentGeneration: FencingGeneration.make(assignment.generation),
              leaseEpoch: AssignmentLeaseEpoch.make(assignment.leaseEpoch),
              commandSequence: Sequence.make(command.sequence),
              event: { _tag: "CellResult", operationKey: input.operationKey, response: terminalResponse },
            })
            .pipe(Effect.mapError(() => failure("transport", "Could not persist Runner terminal event")))
          return { response: terminalResponse, outcome, eventPersisted: true } satisfies FinalResult
        }),
      )
      .pipe(Effect.catchTag("SqlError", () => Effect.fail(failure("transport", "Could not persist Runner terminal"))))
  })

  const timeoutAccepted = (input: OperationInput) => terminalizeAccepted(input, timeoutResponse, "failed")

  const waitForTerminal = (input: LocalExecuteInput): Effect.Effect<FinalResult, GatewayError> =>
    Effect.gen(function* () {
      yield* recoverTerminals().pipe(Effect.ignore)
      const rows = yield* operation(input.assignmentId, input.operationKey, input.attempt).pipe(
        Effect.mapError(() => failure("transport", "Could not read Runner operation")),
      )
      const row = rows[0]
      if (row === undefined) return yield* failure("transport", "Runner operation is unavailable")
      if (row.state === "completed" || row.state === "unknown") {
        const response = yield* decodeResponse(row.response).pipe(
          Effect.mapError(() => failure("transport", "Persisted Runner response is invalid")),
        )
        if (row.terminalOutcome === null)
          return yield* failure("transport", "Persisted Runner terminal outcome is missing")
        const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(input.assignmentId)))
        return {
          ...(session === undefined ? {} : { access: session.access }),
          response,
          outcome: row.terminalOutcome,
          eventPersisted: true as const,
        }
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
      const response = yield* decodeResponse(durable.response).pipe(
        Effect.mapError(() => failure("transport", "Persisted Runner response is invalid")),
      )
      if (durable.terminalOutcome === null)
        return yield* failure("transport", "Persisted Runner terminal outcome is missing")
      const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(request.assignmentId)))
      return {
        ...(session === undefined ? {} : { access: session.access }),
        response,
        outcome: durable.terminalOutcome,
        eventPersisted: true as const,
      }
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
          currentOperation.dispatchedGeneration !== String(currentSession.access.fence.assignmentGeneration) ||
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
    const row = (yield* operation(input.assignmentId, input.operationKey, input.attempt).pipe(
      Effect.mapError(() => failure("transport", "Could not read Runner operation")),
    ))[0]
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
        const rows = yield* operation(input.assignmentId, input.operationKey, input.attempt).pipe(
          Effect.mapError(() => failure("transport", "Could not read Runner operation")),
        )
        const current = rows[0]
        if (current === undefined) return yield* failure("transport", "Runner operation is unavailable")
        if (current.state === "completed" || current.state === "unknown") {
          const response = yield* decodeResponse(current.response).pipe(
            Effect.mapError(() => failure("transport", "Persisted Runner response is invalid")),
          )
          if (current.terminalOutcome === null)
            return yield* failure("transport", "Persisted Runner terminal outcome is missing")
          const session = (yield* Ref.get(sessions)).get(input.assignmentId)
          return {
            ...(session === undefined ? {} : { access: session.access }),
            response,
            outcome: current.terminalOutcome,
            eventPersisted: true,
          }
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
