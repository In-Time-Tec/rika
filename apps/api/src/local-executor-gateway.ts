import * as PgClient from "@effect/sql-pg/PgClient"
import type * as MachineBindings from "@rika/kernel/machine-bindings"
import {
  ApiMessage,
  CellLifecycleFrame as CellLifecycleFrameSchema,
  CellResponse as CellResponseSchema,
  LocalExecutorMessage,
  redactAccess,
  redactHeartbeat,
  type AccessWire,
  type CellLifecycleFrame,
  type CellRequest,
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
import { Cause, Crypto, Deferred, Effect, Encoding, Option, Redacted, Ref, Schema, Semaphore } from "effect"
import { GatewayError, type BindingAuthority } from "./executor-gateway"
import type { LocalExecutorAuthority } from "./local-executor"
import type { Socket } from "./executor-gateway"

interface Session {
  readonly socket: Socket
  readonly access: AccessWire
  readonly leaseExpiresAt: number
}

interface FinalResult {
  readonly access?: AccessWire
  readonly response: CellResponse
  readonly eventPersisted: true
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
  readonly admittedAt: string | null
  readonly deadline: string | null
  readonly state: "accepted" | "dispatched" | "completed" | "unknown"
  readonly dispatchedGeneration: string | null
  readonly dispatchedLeaseEpoch: string | null
  readonly dispatchedExecutorInstanceId: string | null
  readonly dispatchedProcessIncarnation: string | null
  readonly dispatchDeadlineAt: string | null
  readonly response: unknown
}

type LocalExecuteInput = Omit<CellRequest, "access" | "bindings"> & {
  readonly assignmentId: string
  readonly bindings: BindingAuthority
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalExecutorMessage))
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
  admittedAt: Schema.NullOr(Schema.String),
  deadline: Schema.NullOr(Schema.String),
})
const encodeOperationIdentity = Schema.encodeSync(Schema.fromJsonString(OperationIdentity))
const encodeBindingRequest = Schema.encodeSync(Schema.fromJsonString(BindingRequest))
const encodeMachineRequest = Schema.encodeSync(Schema.fromJsonString(MachineRequest))
const key = (assignmentId: string, operationKey: string) => `${assignmentId}\u001f${operationKey}`
const machineKey = (assignmentId: string, operationKey: string, machineId: string) =>
  `${assignmentId}\u001f${operationKey}\u001f${machineId}`
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

const dispatchDeadlineMillis = 5 * 60_000

const unknownResponse: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
}

export interface LocalGateway {
  readonly receive: (socket: Socket, frame: unknown) => Effect.Effect<void>
  readonly disconnected: (socket: Socket) => Effect.Effect<void>
  readonly execute: (input: LocalExecuteInput) => Effect.Effect<FinalResult, GatewayError>
  readonly cancel: (assignmentId: string, operationKey: string) => Effect.Effect<void, GatewayError>
  readonly machine: (
    assignmentId: string,
    operationKey: string,
    request: MachineBindings.Request,
  ) => Effect.Effect<MachineBindings.Outcome, GatewayError>
}

export const makeLocalGateway = Effect.fn("LocalExecutorGateway.make")(function* (authority: LocalExecutorAuthority) {
  const sql = yield* PgClient.PgClient
  const store = yield* HostedStore
  const crypto = yield* Crypto.Crypto
  const sessions = yield* Ref.make(new Map<string, Session>())
  const assignments = yield* Ref.make(new Map<Socket, string>())
  const machineCalls = yield* Ref.make(new Map<string, MachineCall>())
  const pending = yield* Ref.make(new Map<string, Pending>())
  const gatewayLock = yield* Semaphore.make(1)
  const lifecycleLock = yield* Semaphore.make(1)

  const requestDigest = Effect.fn("LocalExecutorGateway.requestDigest")(function* (code: string) {
    const bytes = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(code))
      .pipe(Effect.mapError(() => failure("transport", "Could not identify local executor operation")))
    return Encoding.encodeHex(bytes)
  })

  const operation = (assignmentId: string, operationKey: string) =>
    sql<OperationRow>`SELECT request_digest AS "requestDigest", workspace_id AS "workspaceId",
      session_id AS "sessionId", thread_id AS "threadId", turn_id AS "turnId", run_id AS "runId",
      root_run_id AS "rootRunId", tool_call_id AS "toolCallId", code, attempt::text AS attempt,
      admitted_at AS "admittedAt", deadline, state,
      dispatched_generation::text AS "dispatchedGeneration",
      dispatched_lease_epoch::text AS "dispatchedLeaseEpoch",
      dispatched_executor_instance_id AS "dispatchedExecutorInstanceId",
      dispatched_process_incarnation AS "dispatchedProcessIncarnation",
      to_char(dispatch_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dispatchDeadlineAt", response
      FROM rika_hosted_executor_operations
      WHERE assignment_id = ${assignmentId} AND operation_key = ${operationKey}`

  const lockedOperation = (assignmentId: string, operationKey: string) =>
    sql<OperationRow>`SELECT request_digest AS "requestDigest", workspace_id AS "workspaceId",
      session_id AS "sessionId", thread_id AS "threadId", turn_id AS "turnId", run_id AS "runId",
      root_run_id AS "rootRunId", tool_call_id AS "toolCallId", code, attempt::text AS attempt,
      admitted_at AS "admittedAt", deadline, state,
      dispatched_generation::text AS "dispatchedGeneration",
      dispatched_lease_epoch::text AS "dispatchedLeaseEpoch",
      dispatched_executor_instance_id AS "dispatchedExecutorInstanceId",
      dispatched_process_incarnation AS "dispatchedProcessIncarnation",
      to_char(dispatch_deadline_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "dispatchDeadlineAt", response
      FROM rika_hosted_executor_operations
      WHERE assignment_id = ${assignmentId} AND operation_key = ${operationKey}
      FOR UPDATE`

  const prepare = Effect.fn("LocalExecutorGateway.prepare")(function* (input: LocalExecuteInput) {
    const digest = yield* requestDigest(
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
        admittedAt: input.admittedAt,
        deadline: input.deadline,
      }),
    )
    yield* sql`INSERT INTO rika_hosted_executor_operations
      (assignment_id, owner_id, operation_key, request_digest, workspace_id, session_id, thread_id, turn_id,
       run_id, root_run_id, tool_call_id, code, attempt, admitted_at, deadline, state)
      SELECT assignment.id, assignment.owner_id, ${input.operationKey}, ${digest}, ${input.workspaceId},
        ${input.sessionId}, ${input.threadId}, ${input.turnId}, ${input.runId}, ${input.rootRunId},
        ${input.toolCallId}, ${input.code}, ${input.attempt}, ${input.admittedAt}, ${input.deadline}, 'accepted'
      FROM rika_hosted_executor_assignments assignment
      WHERE assignment.id = ${input.assignmentId}
      ON CONFLICT (assignment_id, operation_key) DO NOTHING`.pipe(
      Effect.mapError(() => failure("transport", "Could not persist local executor operation")),
    )
    const row = (yield* operation(input.assignmentId, input.operationKey).pipe(
      Effect.mapError(() => failure("transport", "Could not read local executor operation")),
    ))[0]
    if (row === undefined) return yield* failure("transport", "Local executor operation is unavailable")
    if (
      row.requestDigest !== digest ||
      row.workspaceId !== input.workspaceId ||
      row.sessionId !== input.sessionId ||
      row.threadId !== input.threadId ||
      row.turnId !== input.turnId ||
      row.runId !== input.runId ||
      row.rootRunId !== input.rootRunId ||
      row.toolCallId !== input.toolCallId ||
      row.code !== input.code ||
      Number(row.attempt) !== input.attempt ||
      row.admittedAt !== input.admittedAt ||
      row.deadline !== input.deadline
    )
      return yield* failure("fenced", "Local executor operation key conflicts with a different request")
    return row
  })

  const claimDispatch = Effect.fn("LocalExecutorGateway.claimDispatch")(function* (input: {
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
            JOIN rika_hosted_local_executor_admissions admission
              ON admission.assignment_id = assignment.id
              AND admission.owner_id = assignment.owner_id
              AND admission.generation = assignment.generation
              AND admission.device_id = assignment.provider_instance_id
              AND admission.process_incarnation = assignment.process_incarnation
              AND admission.consumed_at IS NOT NULL
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
              AND assignment.generation = ${input.session.access.fence.assignmentGeneration}::bigint
              AND assignment.lease_epoch = ${input.session.access.leaseEpoch}::bigint
              AND assignment.lease_expires_at > clock_timestamp()
              AND assignment.provider_instance_id = ${input.session.access.fence.instanceId}
              AND assignment.executor_instance_id = ${input.session.access.fence.executorId}
              AND assignment.process_incarnation = ${input.session.access.fence.processIncarnation}
              AND assignment.session_digest = ${sessionDigest}
            FOR UPDATE`.pipe(Effect.mapError(() => failure("transport", "Could not claim local executor fence")))
          if (assignmentRows[0] === undefined)
            return yield* failure("fenced", "Local executor fence is no longer current")
          const rows = yield* lockedOperation(input.session.access.fence.assignmentId, input.operationKey).pipe(
            Effect.mapError(() => failure("transport", "Could not lock local executor operation")),
          )
          const operationRow = rows[0]
          if (operationRow === undefined) return yield* failure("transport", "Local executor operation is unavailable")
          if (operationRow.state !== "accepted")
            return yield* failure("fenced", "Local executor operation changed before dispatch")
          const updated = yield* sql`UPDATE rika_hosted_executor_operations SET
            state = 'dispatched', dispatched_generation = ${input.session.access.fence.assignmentGeneration}::bigint,
            dispatched_lease_epoch = ${input.session.access.leaseEpoch}::bigint,
            dispatched_executor_instance_id = ${input.session.access.fence.executorId},
            dispatched_process_incarnation = ${input.session.access.fence.processIncarnation},
            dispatch_deadline_at = clock_timestamp() + (${dispatchDeadlineMillis} * interval '1 millisecond'),
            updated_at = clock_timestamp()
            WHERE assignment_id = ${input.session.access.fence.assignmentId}
              AND operation_key = ${input.operationKey} AND attempt = ${input.attempt}::bigint
              AND state = 'accepted' RETURNING operation_key`.pipe(
            Effect.mapError(() => failure("transport", "Could not persist local executor dispatch")),
          )
          if (updated[0] === undefined)
            return yield* failure("fenced", "Local executor operation changed before dispatch")
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () => Effect.fail(failure("transport", "Could not claim local executor fence"))),
      )
  })

  const register = Effect.fn("LocalExecutorGateway.register")(function* (session: Session) {
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
        yield* Ref.update(machineCalls, (current) => {
          const next = new Map(current)
          for (const [callKey, call] of next)
            if (call.assignmentId === id) next.set(callKey, { ...call, socket: session.socket, access: session.access })
          return next
        })
        if (previous !== undefined && previous.socket !== session.socket) previous.socket.close(1008, "fenced")
      }),
    )
  })

  const replayPending = Effect.fn("LocalExecutorGateway.replayPending")(function* (session: Session) {
    for (const pendingOperation of (yield* Ref.get(pending)).values())
      if (pendingOperation.assignmentId === session.access.fence.assignmentId)
        session.socket.send(
          encode({
            _tag: "CellReplay",
            access: session.access,
            operationKey: pendingOperation.operationKey,
            afterCursor: 0,
          }),
        )
    for (const call of (yield* Ref.get(machineCalls)).values())
      if (call.assignmentId === session.access.fence.assignmentId)
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
  })

  const receiveBinding = Effect.fn("LocalExecutorGateway.receiveBinding")(function* (
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
      assignmentId === undefined ? undefined : (yield* Ref.get(pending)).get(key(assignmentId, operationKey))
    if (
      pendingOperation === undefined ||
      pendingOperation.socket !== socket ||
      pendingOperation.attempt !== attempt ||
      !same(pendingOperation.access, access) ||
      request.sessionId !== pendingOperation.request.sessionId ||
      request.cellId !== pendingOperation.request.toolCallId
    )
      return yield* failure("fenced", "Local binding call has a stale cell identity")
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
    if (call.result === candidate) {
      const outcome = yield* pendingOperation.bindings.registry.invoke({ ...request, input: request.input }).pipe(
        Effect.provideContext(pendingOperation.bindings.context),
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
    const current = (yield* Ref.get(sessions)).get(pendingOperation.assignmentId)
    if (current === undefined) return yield* failure("disconnected", "Local binding result has no executor")
    current.socket.send(
      encode({
        _tag: "BindingResult",
        access: current.access,
        operationKey,
        attempt,
        callId,
        requestDigest: digest,
        outcome,
      }),
    )
  })

  const receiveMachine = Effect.fn("LocalExecutorGateway.receiveMachine")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    machineId: string,
    digest: string,
    outcome: MachineOutcome,
  ) {
    const assignmentId = (yield* Ref.get(assignments)).get(socket)
    if (assignmentId === undefined) return yield* failure("fenced", "Local machine result has no executor")
    const call = (yield* Ref.get(machineCalls)).get(machineKey(assignmentId, operationKey, machineId))
    if (
      call === undefined ||
      call.socket !== socket ||
      call.attempt !== attempt ||
      call.requestDigest !== digest ||
      !same(call.access, access)
    )
      return yield* failure("fenced", "Local machine result conflicts with its request")
    yield* Deferred.succeed(call.result, outcome)
  })

  const finalize = Effect.fn("LocalExecutorGateway.finalize")(function* (input: {
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
    if (assignmentId === undefined) return yield* failure("fenced", "Local executor assignment is unavailable")
    if (input.state === "completed") {
      if (input.access === undefined)
        return yield* failure("fenced", "Local executor completion has no authenticated access")
      yield* authority
        .validateAccess(redactAccess(input.access))
        .pipe(Effect.mapError((error) => failure("fenced", error.message)))
    }
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* lockedOperation(assignmentId, input.operationKey).pipe(
            Effect.mapError(() => failure("transport", "Could not lock local executor operation")),
          )
          const current = rows[0]
          if (current === undefined) return yield* failure("transport", "Local executor operation is unavailable")
          if (Number(current.attempt) !== input.attempt)
            return yield* failure("fenced", "Local executor operation attempt is stale")
          if (current.state === "completed" || current.state === "unknown") {
            const previous = yield* decodeResponse(current.response).pipe(
              Effect.mapError(() => failure("transport", "Persisted local executor response is invalid")),
            )
            if (!equivalentResponse(previous, input.response)) {
              if (input.state === "unknown" && current.state === "completed")
                return {
                  ...(input.access === undefined ? {} : { access: input.access }),
                  response: previous,
                  eventPersisted: true as const,
                }
              return yield* failure("fenced", "Local executor operation already has a different terminal result")
            }
            return {
              ...(input.access === undefined ? {} : { access: input.access }),
              response: previous,
              eventPersisted: true as const,
            }
          }
          if (current.state !== "dispatched")
            return yield* failure("fenced", "Local executor operation was not dispatched")
          if (
            current.dispatchedGeneration === null ||
            current.dispatchedLeaseEpoch === null ||
            current.dispatchedExecutorInstanceId === null ||
            current.dispatchedProcessIncarnation === null
          )
            return yield* failure("fenced", "Local executor operation has an incomplete dispatch fence")
          const persistedFence = {
            assignmentGeneration: current.dispatchedGeneration,
            leaseEpoch: current.dispatchedLeaseEpoch,
            executorInstanceId: current.dispatchedExecutorInstanceId,
            processIncarnation: current.dispatchedProcessIncarnation,
          }
          if (
            input.state === "completed" &&
            (input.access === undefined ||
              input.access.fence.assignmentId !== assignmentId ||
              String(input.access.fence.assignmentGeneration) !== persistedFence.assignmentGeneration ||
              input.access.fence.executorId !== persistedFence.executorInstanceId ||
              input.access.fence.processIncarnation !== persistedFence.processIncarnation)
          )
            return yield* failure("fenced", "Local executor completion does not match the dispatched fence")
          const expectedFence = input.dispatchedFence ?? persistedFence
          if (
            persistedFence.assignmentGeneration !== expectedFence.assignmentGeneration ||
            persistedFence.leaseEpoch !== expectedFence.leaseEpoch ||
            persistedFence.executorInstanceId !== expectedFence.executorInstanceId ||
            persistedFence.processIncarnation !== expectedFence.processIncarnation
          )
            return yield* failure("fenced", "Local executor operation was not dispatched to this fence")
          const updated = yield* sql`UPDATE rika_hosted_executor_operations SET
              state = ${input.state}, response = ${sql.json(input.response)},
              dispatch_deadline_at = NULL, updated_at = clock_timestamp()
              WHERE assignment_id = ${assignmentId} AND operation_key = ${input.operationKey}
                AND attempt = ${input.attempt}::bigint AND state = 'dispatched'
                AND dispatched_generation = ${expectedFence.assignmentGeneration}::bigint
                AND dispatched_lease_epoch = ${expectedFence.leaseEpoch}::bigint
                AND dispatched_executor_instance_id = ${expectedFence.executorInstanceId}
                AND dispatched_process_incarnation = ${expectedFence.processIncarnation}
              RETURNING operation_key`.pipe(
            Effect.mapError(() => failure("transport", "Could not persist local executor result")),
          )
          if (updated[0] === undefined) return yield* failure("fenced", "Local executor result lost its fence")
          const commands = yield* sql<{ readonly sequence: string }>`SELECT sequence::text AS sequence
          FROM rika_hosted_thread_commands
          WHERE thread_id = ${assignmentId} AND idempotency_key = ${input.operationKey}
          LIMIT 1`.pipe(Effect.mapError(() => failure("transport", "Local executor command is unavailable")))
          const command = commands[0]
          if (command === undefined) return yield* failure("transport", "Local executor command is unavailable")
          const event = {
            eventId: EventId.make(input.operationKey),
            idempotencyKey: IdempotencyKey.make(input.operationKey),
            assignmentId: ExecutorAssignmentId.make(assignmentId),
            assignmentGeneration: FencingGeneration.make(expectedFence.assignmentGeneration),
            leaseEpoch: AssignmentLeaseEpoch.make(
              input.state === "completed" && input.access !== undefined
                ? String(input.access.leaseEpoch)
                : expectedFence.leaseEpoch,
            ),
            commandSequence: Sequence.make(command.sequence),
            event: { _tag: "CellResult", operationKey: input.operationKey, response: input.response },
          }
          if (input.state === "unknown")
            yield* store
              .appendRecoveredEvent({
                ...event,
                assignmentGeneration: FencingGeneration.make(expectedFence.assignmentGeneration),
                leaseEpoch: AssignmentLeaseEpoch.make(expectedFence.leaseEpoch),
                executorInstanceId: expectedFence.executorInstanceId,
                processIncarnation: expectedFence.processIncarnation,
              })
              .pipe(Effect.mapError(() => failure("transport", "Could not persist local executor recovery event")))
          else
            yield* store
              .appendEvent(event)
              .pipe(Effect.mapError(() => failure("transport", "Could not persist local executor event")))
          return {
            ...(input.access === undefined ? {} : { access: input.access }),
            response: input.response,
            eventPersisted: true as const,
          }
        }),
      )
      .pipe(
        Effect.catchTag("SqlError", () => Effect.fail(failure("transport", "Could not persist local executor result"))),
      )
  })

  const settlePending = Effect.fn("LocalExecutorGateway.settlePending")(function* (
    assignmentId: string,
    operationKey: string,
    result: FinalResult,
  ) {
    const entry = yield* gatewayLock.withPermits(1)(
      Ref.get(pending).pipe(Effect.map((current) => current.get(key(assignmentId, operationKey)))),
    )
    if (entry !== undefined) yield* Deferred.succeed(entry.result, result)
  })

  const recoverStale = Effect.fn("LocalExecutorGateway.recoverStale")(function* (access: AccessWire) {
    const rows = yield* sql<{
      readonly operationKey: string
      readonly attempt: string
      readonly dispatchedGeneration: string
      readonly dispatchedLeaseEpoch: string
      readonly dispatchedExecutorInstanceId: string | null
      readonly dispatchedProcessIncarnation: string | null
    }>`SELECT operation_key AS "operationKey", attempt::text AS attempt,
        dispatched_generation::text AS "dispatchedGeneration",
        dispatched_lease_epoch::text AS "dispatchedLeaseEpoch",
        dispatched_executor_instance_id AS "dispatchedExecutorInstanceId",
        dispatched_process_incarnation AS "dispatchedProcessIncarnation"
      FROM rika_hosted_executor_operations
      WHERE assignment_id = ${access.fence.assignmentId} AND state = 'dispatched'
        AND (
          dispatched_generation <> ${access.fence.assignmentGeneration}::bigint
          OR dispatched_executor_instance_id IS DISTINCT FROM ${access.fence.executorId}
          OR dispatched_process_incarnation IS DISTINCT FROM ${access.fence.processIncarnation}
        )`.pipe(Effect.mapError(() => failure("transport", "Could not recover local executor operations")))
    yield* Effect.forEach(
      rows,
      (row) =>
        row.dispatchedExecutorInstanceId === null || row.dispatchedProcessIncarnation === null
          ? Effect.void
          : finalize({
              assignmentId: access.fence.assignmentId,
              access,
              operationKey: row.operationKey,
              attempt: Number(row.attempt),
              response: unknownResponse,
              state: "unknown",
              dispatchedFence: {
                assignmentGeneration: row.dispatchedGeneration,
                leaseEpoch: row.dispatchedLeaseEpoch,
                executorInstanceId: row.dispatchedExecutorInstanceId,
                processIncarnation: row.dispatchedProcessIncarnation!,
              },
            }).pipe(
              Effect.flatMap((result) => settlePending(access.fence.assignmentId, row.operationKey, result)),
              Effect.ignore,
            ),
      { discard: true },
    )
  })

  const recoverDue = Effect.fn("LocalExecutorGateway.recoverDue")(function* () {
    const rows = yield* sql<{
      readonly assignmentId: string
      readonly operationKey: string
      readonly attempt: string
      readonly dispatchedGeneration: string
      readonly dispatchedLeaseEpoch: string
      readonly dispatchedExecutorInstanceId: string | null
      readonly dispatchedProcessIncarnation: string | null
    }>`SELECT operation.assignment_id AS "assignmentId", operation.operation_key AS "operationKey",
        operation.attempt::text AS attempt, operation.dispatched_generation::text AS "dispatchedGeneration",
        operation.dispatched_lease_epoch::text AS "dispatchedLeaseEpoch",
        operation.dispatched_executor_instance_id AS "dispatchedExecutorInstanceId",
        operation.dispatched_process_incarnation AS "dispatchedProcessIncarnation"
      FROM rika_hosted_executor_operations operation
      JOIN rika_hosted_executor_assignments assignment ON assignment.id = operation.assignment_id
      WHERE operation.state = 'dispatched'
        AND (
          operation.dispatch_deadline_at <= clock_timestamp()
          OR assignment.lifecycle <> 'active'
          OR assignment.lease_expires_at <= clock_timestamp()
          OR assignment.generation <> operation.dispatched_generation
          OR assignment.executor_instance_id IS DISTINCT FROM operation.dispatched_executor_instance_id
          OR assignment.process_incarnation IS DISTINCT FROM operation.dispatched_process_incarnation
        )`.pipe(Effect.mapError(() => failure("transport", "Could not inspect local executor recovery queue")))
    yield* Effect.forEach(
      rows,
      (row) =>
        row.dispatchedExecutorInstanceId === null || row.dispatchedProcessIncarnation === null
          ? Effect.void
          : finalize({
              assignmentId: row.assignmentId,
              operationKey: row.operationKey,
              attempt: Number(row.attempt),
              response: unknownResponse,
              state: "unknown",
              dispatchedFence: {
                assignmentGeneration: row.dispatchedGeneration,
                leaseEpoch: row.dispatchedLeaseEpoch,
                executorInstanceId: row.dispatchedExecutorInstanceId,
                processIncarnation: row.dispatchedProcessIncarnation!,
              },
            }).pipe(
              Effect.flatMap((result) => settlePending(row.assignmentId, row.operationKey, result)),
              Effect.ignore,
            ),
      { discard: true },
    )
  })

  const disconnected = Effect.fn("LocalExecutorGateway.disconnected")(function* (socket: Socket) {
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

  const shutdown = Effect.fn("LocalExecutorGateway.shutdown")(function* (socket: Socket, access: AccessWire) {
    const detached = yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const id = yield* Ref.get(assignments).pipe(Effect.map((current) => current.get(socket)))
        const currentSession =
          id === undefined ? undefined : yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(id)))
        if (
          id === undefined ||
          id !== access.fence.assignmentId ||
          currentSession?.socket !== socket ||
          !same(currentSession.access, access)
        )
          return yield* failure("fenced", "Local executor shutdown does not match the current session")
        yield* Ref.update(assignments, (current) => {
          const next = new Map(current)
          next.delete(socket)
          return next
        })
        yield* Ref.update(sessions, (current) => {
          const next = new Map(current)
          next.delete(id)
          return next
        })
        const values = yield* Ref.modify(pending, (current) => {
          const matches = [...current.entries()].filter(([, value]) => value.assignmentId === id)
          const next = new Map(current)
          for (const [name] of matches) next.delete(name)
          return [matches.map(([, value]) => value), next] as const
        })
        return values
      }),
    )
    yield* Effect.forEach(
      detached,
      (value) =>
        finalize({
          access: value.access,
          operationKey: value.operationKey,
          attempt: value.attempt,
          response: unknownResponse,
          state: "unknown",
        }).pipe(
          Effect.matchEffect({
            onFailure: () => Deferred.fail(value.result, failure("disconnected", "Local executor shut down")),
            onSuccess: (result) => Deferred.succeed(value.result, result),
          }),
        ),
      { discard: true },
    )
    yield* authority.release(redactAccess(access)).pipe(Effect.ignore)
  })

  const complete = Effect.fn("LocalExecutorGateway.complete")(function* (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    response: CellResponse,
  ) {
    const pendingCurrent = yield* gatewayLock.withPermits(1)(
      Ref.get(pending).pipe(Effect.map((value) => value.get(key(access.fence.assignmentId, operationKey)))),
    )
    const terminalRows = yield* sql<{ readonly frame: unknown }>`SELECT frame
      FROM rika_hosted_executor_operation_frames
      WHERE assignment_id = ${access.fence.assignmentId}
        AND operation_key = ${operationKey}
        AND kind = 'Terminal'`.pipe(
      Effect.mapError(() => failure("transport", "Could not read local executor terminal receipt")),
    )
    const terminal = terminalRows[0]
    if (terminal === undefined)
      return yield* failure("fenced", "Local executor result arrived before its terminal receipt")
    const terminalFrame = yield* decodeLifecycle(terminal.frame).pipe(
      Effect.mapError(() => failure("transport", "Persisted local executor terminal receipt is invalid")),
    )
    if (terminalFrame._tag !== "Terminal" || !equivalentResponse(terminalFrame.response, response))
      return yield* failure("fenced", "Local executor result conflicts with its terminal receipt")
    const result = yield* gatewayLock
      .withPermits(1)(
        Effect.gen(function* () {
          const id = yield* Ref.get(assignments).pipe(Effect.map((value) => value.get(socket)))
          if (id === undefined || id !== access.fence.assignmentId)
            return yield* failure("fenced", "Local executor result came from an unregistered socket")
          const currentSession = yield* Ref.get(sessions).pipe(Effect.map((value) => value.get(id)))
          if (currentSession === undefined || currentSession.socket !== socket || !same(currentSession.access, access))
            return yield* failure("fenced", "Local executor result does not match the current executor session")
          if (pendingCurrent !== undefined && pendingCurrent.attempt !== attempt)
            return yield* failure("fenced", "Local executor result attempt is stale")
        }),
      )
      .pipe(
        Effect.andThen(finalize({ access, operationKey, attempt, response, state: "completed" })),
        Effect.tapError((error) =>
          pendingCurrent === undefined ? Effect.void : Deferred.fail(pendingCurrent.result, error).pipe(Effect.asVoid),
        ),
      )
    if (pendingCurrent !== undefined) yield* Deferred.succeed(pendingCurrent.result, result)
    return result
  })

  const persistLifecycle = Effect.fn("LocalExecutorGateway.persistLifecycle")(function* (
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
          return yield* failure("fenced", "Local executor lifecycle frame has a stale session")
        const persisted = (yield* operation(assignmentId, frame.attribution.operationKey).pipe(
          Effect.mapError(() => failure("transport", "Could not read local executor lifecycle operation")),
        ))[0]
        const attribution = frame.attribution
        if (
          persisted === undefined ||
          Number(persisted.attempt) !== attribution.attempt ||
          persisted.workspaceId !== attribution.workspaceId ||
          persisted.sessionId !== attribution.sessionId ||
          persisted.threadId !== attribution.threadId ||
          persisted.turnId !== attribution.turnId ||
          persisted.runId !== attribution.runId ||
          persisted.rootRunId !== attribution.rootRunId ||
          persisted.toolCallId !== attribution.toolCallId
        )
          return yield* failure("fenced", "Local executor lifecycle attribution is invalid")
        const stored = yield* sql<{ readonly frame: unknown }>`SELECT frame
          FROM rika_hosted_executor_operation_frames
          WHERE assignment_id = ${assignmentId} AND operation_key = ${attribution.operationKey}
          ORDER BY cursor`.pipe(
          Effect.mapError(() => failure("transport", "Could not read local executor lifecycle frames")),
        )
        const known = yield* Effect.forEach(stored, (row) =>
          decodeLifecycle(row.frame).pipe(
            Effect.mapError(() => failure("transport", "Persisted local executor lifecycle frame is invalid")),
          ),
        )
        const existing = known.find((retained) => retained.cursor === frame.cursor)
        if (existing !== undefined && !equivalentLifecycle(existing, frame))
          return yield* failure("fenced", "Local executor lifecycle cursor has different content")
        if (existing === undefined) {
          if (
            frame.cursor !== known.length + 1 ||
            known.some((retained) => retained._tag === "Terminal") ||
            (frame.cursor === 1 && frame._tag !== "Accepted") ||
            (frame.cursor === 2 && frame._tag !== "Started") ||
            (frame.cursor > 2 && frame._tag !== "Output" && frame._tag !== "Terminal") ||
            (frame._tag === "Output" && known.filter((retained) => retained._tag === "Output").length >= 16)
          )
            return yield* failure("fenced", "Local executor lifecycle sequence is invalid")
          yield* sql`INSERT INTO rika_hosted_executor_operation_frames
            (assignment_id, operation_key, attempt, cursor, kind, frame)
            VALUES (${assignmentId}, ${attribution.operationKey}, ${attribution.attempt},
              ${frame.cursor}, ${frame._tag}, ${sql.json(frame)})`.pipe(
            Effect.mapError(() => failure("transport", "Could not persist local executor lifecycle frame")),
          )
        }
        if (frame._tag === "Terminal")
          socket.send(
            encode({
              _tag: "CellTerminalReceipt",
              access,
              operationKey: attribution.operationKey,
              attempt: attribution.attempt,
              cursor: frame.cursor,
            }),
          )
      }),
    )
  })

  const receive = (socket: Socket, frame: unknown) =>
    decode(frame).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.sync(() => socket.close(1007, "malformed")),
        onSuccess: (message) => {
          if (message._tag === "LocalExecutorHello")
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
                recoverStale({
                  version: 1,
                  fence: welcome.fence,
                  leaseEpoch: welcome.leaseEpoch,
                  sessionToken: Redacted.value(welcome.sessionToken),
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
                  Effect.andThen(recoverStale(session.access)),
                  Effect.andThen(
                    Effect.sync(() => {
                      socket.send(encode({ _tag: "ExecutorReconnected", welcome }))
                    }),
                  ),
                  Effect.andThen(replayPending(session)),
                )
              }),
              Effect.catch((error) => Effect.sync(() => socket.close(1008, error.kind))),
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
              Effect.catch((error) => Effect.sync(() => socket.close(1008, error.kind))),
            )
          if (message._tag === "CellLifecycle")
            return persistLifecycle(socket, message.access, message.frame).pipe(
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "BindingInvoke")
            return receiveBinding(
              socket,
              message.access,
              message.operationKey,
              message.attempt,
              message.callId,
              message.requestDigest,
              message.request,
            ).pipe(Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))))
          if (message._tag === "MachineResult")
            return receiveMachine(
              socket,
              message.access,
              message.operationKey,
              message.attempt,
              message.machineId,
              message.requestDigest,
              message.outcome,
            ).pipe(Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))))
          if (message._tag === "LocalExecutorGoodbye")
            return shutdown(socket, message.access).pipe(
              Effect.tap(() => Effect.sync(() => socket.close(1000, "shutdown"))),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag !== "LocalCellResult") return Effect.void
          return complete(socket, message.access, message.operationKey, message.attempt, message.response).pipe(
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

  const waitForTerminal = (input: {
    readonly assignmentId: string
    readonly operationKey: string
  }): Effect.Effect<FinalResult, GatewayError> =>
    Effect.gen(function* () {
      yield* recoverDue().pipe(Effect.ignore)
      const rows = yield* operation(input.assignmentId, input.operationKey).pipe(
        Effect.mapError(() => failure("transport", "Could not read local executor operation")),
      )
      const row = rows[0]
      if (row === undefined) return yield* failure("transport", "Local executor operation is unavailable")
      if (row.state === "completed" || row.state === "unknown") {
        const response = yield* decodeResponse(row.response).pipe(
          Effect.mapError(() => failure("transport", "Persisted local executor response is invalid")),
        )
        const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(input.assignmentId)))
        return { ...(session === undefined ? {} : { access: session.access }), response, eventPersisted: true as const }
      }
      return yield* Effect.sleep("100 millis").pipe(Effect.andThen(waitForTerminal(input)))
    }).pipe(
      Effect.timeoutOption("60 seconds"),
      Effect.flatMap((value) =>
        Option.isNone(value)
          ? Effect.fail(failure("timeout", "Local executor operation did not reach a terminal state"))
          : Effect.succeed(value.value),
      ),
    )

  const execute = Effect.fn("LocalExecutorGateway.execute")(function* (input: LocalExecuteInput) {
    yield* recoverDue().pipe(Effect.ignore)
    const pendingKey = key(input.assignmentId, input.operationKey)
    const existingPending = yield* gatewayLock.withPermits(1)(
      Ref.get(pending).pipe(Effect.map((current) => current.get(pendingKey))),
    )
    if (existingPending !== undefined) {
      if (existingPending.code !== input.code)
        return yield* failure("fenced", "Local executor operation identity conflicts with different code")
      return yield* Deferred.await(existingPending.result)
    }

    const durable = yield* prepare(input)
    if (durable.state === "completed" || durable.state === "unknown") {
      const response = yield* decodeResponse(durable.response).pipe(
        Effect.mapError(() => failure("transport", "Persisted local executor response is invalid")),
      )
      const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(input.assignmentId)))
      return { ...(session === undefined ? {} : { access: session.access }), response, eventPersisted: true as const }
    }
    if (durable.state === "dispatched") {
      const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(input.assignmentId)))
      if (session !== undefined) {
        yield* recoverStale(session.access)
        const refreshed = yield* prepare(input)
        if (refreshed.state === "completed" || refreshed.state === "unknown") {
          const response = yield* decodeResponse(refreshed.response).pipe(
            Effect.mapError(() => failure("transport", "Persisted local executor response is invalid")),
          )
          return { access: session.access, response, eventPersisted: true as const }
        }
      }
      return yield* waitForTerminal({ assignmentId: input.assignmentId, operationKey: input.operationKey })
    }

    const session = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(input.assignmentId)))
    if (session === undefined)
      return yield* waitForTerminal({ assignmentId: input.assignmentId, operationKey: input.operationKey })
    const workspace = yield* authority
      .workspaceIdentity(redactAccess(session.access))
      .pipe(Effect.mapError((error) => failure("fenced", error.message)))
    const setup = yield* gatewayLock.withPermits(1)(
      Effect.gen(function* () {
        const currentPending = yield* Ref.get(pending).pipe(Effect.map((current) => current.get(pendingKey)))
        if (currentPending !== undefined) {
          if (currentPending.code !== input.code)
            return yield* failure("fenced", "Local executor operation identity conflicts with different code")
          return { existing: currentPending } as const
        }
        const currentSession = yield* Ref.get(sessions).pipe(Effect.map((current) => current.get(input.assignmentId)))
        if (
          currentSession === undefined ||
          currentSession.socket !== session.socket ||
          !same(currentSession.access, session.access)
        )
          return yield* failure("disconnected", "Local executor disconnected before dispatch")
        yield* authority
          .validateAccess(redactAccess(currentSession.access))
          .pipe(Effect.mapError((error) => failure("fenced", error.message)))
        yield* claimDispatch({
          session: currentSession,
          operationKey: input.operationKey,
          attempt: Number(durable.attempt),
        })
        const result = yield* Deferred.make<FinalResult, GatewayError>()
        const current: Pending = {
          assignmentId: input.assignmentId,
          operationKey: input.operationKey,
          attempt: Number(durable.attempt),
          code: input.code,
          request: input,
          socket: currentSession.socket,
          access: currentSession.access,
          result,
          bindings: input.bindings,
          bindingCalls: yield* Ref.make(new Map()),
          nextMachineOrdinal: yield* Ref.make(0),
        }
        yield* Ref.update(pending, (values) => new Map(values).set(pendingKey, current))
        const sent = yield* Effect.try({
          try: () => {
            currentSession.socket.send(
              encode({
                _tag: "CellExecute",
                request: {
                  access: currentSession.access,
                  operationKey: input.operationKey,
                  workspaceId: workspace,
                  sessionId: input.sessionId,
                  threadId: input.threadId,
                  turnId: input.turnId,
                  runId: input.runId,
                  toolCallId: input.toolCallId,
                  code: input.code,
                  rootRunId: input.rootRunId,
                  attempt: current.attempt,
                  admittedAt: input.admittedAt,
                  deadline: input.deadline,
                  bindings: input.bindings.manifest,
                },
              }),
            )
          },
          catch: () => failure("disconnected", "Local executor delivery failed"),
        }).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
        return { current, sent } as const
      }),
    )
    if ("existing" in setup) return yield* Deferred.await(setup.existing.result)
    return yield* Effect.gen(function* () {
      if (!setup.sent)
        return yield* finalize({
          access: setup.current.access,
          operationKey: input.operationKey,
          attempt: setup.current.attempt,
          response: unknownResponse,
          state: "unknown",
        })
      return yield* Deferred.await(setup.current.result).pipe(
        Effect.onInterrupt(() =>
          Effect.try({
            try: () =>
              setup.current.socket.send(
                encode({
                  _tag: "CellCancel",
                  access: setup.current.access,
                  operationKey: setup.current.operationKey,
                  attempt: setup.current.attempt,
                }),
              ),
            catch: () => undefined,
          }).pipe(Effect.ignore),
        ),
      )
    }).pipe(
      Effect.ensuring(
        Effect.all(
          [
            Ref.update(pending, (values) => {
              const next = new Map(values)
              if (next.get(pendingKey) === setup.current) next.delete(pendingKey)
              return next
            }),
            Ref.update(machineCalls, (values) => {
              const prefix = `${input.assignmentId}\u001f${input.operationKey}\u001f`
              return new Map(Array.from(values).filter(([callKey]) => !callKey.startsWith(prefix)))
            }),
          ],
          { discard: true },
        ),
      ),
    )
  })

  const cancel = Effect.fn("LocalExecutorGateway.cancel")(function* (assignmentId: string, operationKey: string) {
    const pendingOperation = (yield* Ref.get(pending)).get(key(assignmentId, operationKey))
    const session = (yield* Ref.get(sessions)).get(assignmentId)
    if (pendingOperation === undefined || session === undefined || pendingOperation.socket !== session.socket)
      return yield* failure("disconnected", "Local executor operation is not running")
    yield* Effect.try({
      try: () =>
        session.socket.send(
          encode({ _tag: "CellCancel", access: session.access, operationKey, attempt: pendingOperation.attempt }),
        ),
      catch: () => failure("transport", "Could not cancel local executor operation"),
    })
  })

  const machine = Effect.fn("LocalExecutorGateway.machine")(function* (
    assignmentId: string,
    operationKey: string,
    request: MachineBindings.Request,
  ) {
    const pendingOperation = (yield* Ref.get(pending)).get(key(assignmentId, operationKey))
    const session = (yield* Ref.get(sessions)).get(assignmentId)
    if (pendingOperation === undefined || session === undefined)
      return yield* failure("disconnected", "Local cell authority is no longer available")
    const ordinal = yield* Ref.getAndUpdate(pendingOperation.nextMachineOrdinal, (current) => current + 1)
    const machineId = `${pendingOperation.request.toolCallId}:${ordinal}`
    const digest = yield* requestDigest(encodeMachineRequest(request))
    const result = yield* Deferred.make<MachineBindings.Outcome>()
    const mapKey = machineKey(assignmentId, operationKey, machineId)
    const candidate: MachineCall = {
      assignmentId,
      operationKey,
      attempt: pendingOperation.attempt,
      machineId,
      requestDigest: digest,
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
    if (call.requestDigest !== digest)
      return { _tag: "Fenced" as const, message: "Local machine call id conflicts with a different request" }
    if (call === candidate) {
      const sent = yield* Effect.try({
        try: () =>
          session.socket.send(
            encode({
              _tag: "MachineExecute",
              access: session.access,
              operationKey,
              attempt: pendingOperation.attempt,
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
      if (!sent) return { _tag: "Unknown" as const, message: "Local machine delivery is uncertain" }
    }
    return yield* Deferred.await(call.result)
  })

  const pollAccepted = Effect.fn("LocalExecutorGateway.pollAccepted")(function* () {
    yield* recoverDue().pipe(Effect.ignore)
  })

  const pollTick = Effect.sleep("100 millis").pipe(Effect.andThen(pollAccepted()), Effect.ignore)
  yield* Effect.forever(pollTick).pipe(Effect.forkScoped)

  return { receive, disconnected, execute, cancel, machine }
})
