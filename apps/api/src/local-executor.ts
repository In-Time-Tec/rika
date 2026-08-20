import * as PgClient from "@effect/sql-pg/PgClient"
import { Context, Crypto, DateTime, Effect, Encoding, Layer, Redacted } from "effect"
import { ControllerError, type Receipt, type ReconnectWelcome, type Welcome } from "@rika/e2b-executor/controller"
import { type ExecutorAssignment } from "@rika/product/executor-assignment"
import { AssignmentError, ExecutorAssignments, type Access } from "@rika/product/executor-assignments"
import {
  AssignmentLeaseEpoch,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  Sequence,
} from "@rika/product/hosted-model"
import type { Access as ProtocolAccess, Heartbeat } from "@rika/remote-execution/protocol"

const leaseLifetimeMillis = 60_000
const heartbeatIntervalMillis = 20_000
const admissionLifetimeMillis = 60_000

export interface LocalActor {
  readonly organizationIds: ReadonlyArray<string>
  readonly deviceId: string
  readonly clientId: string
  readonly userId: string
  readonly memberId: string
}

export interface LocalAdmission {
  readonly admissionId: string
  readonly ticket: string
  readonly expiresAt: number
  readonly executorUrl: string
  readonly workspaceIdentity: string
}

export interface LocalExecutorAuthority {
  readonly admit: (input: {
    readonly threadId: string
    readonly organizationId: string
    readonly workspaceFingerprint: string
    readonly actor: LocalActor
    readonly executorUrl: string
  }) => Effect.Effect<LocalAdmission, ControllerError>
  readonly hello: (input: {
    readonly admissionId: string
    readonly ticket: string
    readonly processIncarnation: string
  }) => Effect.Effect<Welcome, ControllerError>
  readonly reconnect: (access: ProtocolAccess) => Effect.Effect<ReconnectWelcome, ControllerError>
  readonly validateAccess: (access: ProtocolAccess) => Effect.Effect<void, ControllerError>
  readonly workspaceIdentity: (access: ProtocolAccess) => Effect.Effect<string, ControllerError>
  readonly heartbeat: (heartbeat: Heartbeat) => Effect.Effect<Receipt, ControllerError>
  readonly release: (access: ProtocolAccess) => Effect.Effect<void, ControllerError>
}

export class LocalExecutor extends Context.Service<LocalExecutor, LocalExecutorAuthority>()(
  "@rika/api/local-executor/LocalExecutor",
) {}

const failure = (kind: ControllerError["kind"], message: string) => ControllerError.make({ kind, message })
const number = (value: string) => Number(value)
const epochMillis = (value: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(value))
const assignmentFailure = (cause: AssignmentError) => {
  if (cause.reason === "not-found") return failure("assignment-missing", cause.message)
  if (cause.reason === "authentication") return failure("authentication", cause.message)
  if (cause.reason === "stale-fence") return failure("fenced", cause.message)
  return failure("repository", cause.message)
}
const version = (assignment: ExecutorAssignment) => ({
  assignmentId: assignment.id,
  generation: assignment.generation,
  revision: assignment.revision,
})

interface AdmissionRow {
  readonly id: string
  readonly assignmentId: string
  readonly organizationId: string
  readonly deviceId: string
  readonly clientId: string
  readonly userId: string
  readonly memberId: string
  readonly generation: string
  readonly workspaceFingerprint: string
  readonly expiresAt: string
}

export const layer = Layer.effect(
  LocalExecutor,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const assignments = yield* ExecutorAssignments
    const crypto = yield* Crypto.Crypto

    const digest = Effect.fn("LocalExecutor.digest")(function* (secret: string) {
      const bytes = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(secret))
        .pipe(Effect.mapError(() => failure("authentication", "Credential verification failed")))
      return Redacted.make(Encoding.encodeHex(bytes), { label: "local-executor-ticket-digest" })
    })
    const secret = Effect.fn("LocalExecutor.secret")(function* (label: string) {
      const bytes = yield* crypto
        .randomBytes(32)
        .pipe(Effect.mapError(() => failure("authentication", "Credential issuance failed")))
      return Redacted.make(Encoding.encodeBase64Url(bytes), { label })
    })
    const load = Effect.fn("LocalExecutor.load")(function* (assignmentId: string) {
      const assignment = yield* assignments
        .get(ExecutorAssignmentId.make(assignmentId))
        .pipe(Effect.mapError(assignmentFailure))
      if (assignment === undefined) return yield* failure("assignment-missing", "Local assignment does not exist")
      return assignment
    })
    const local = (assignment: ExecutorAssignment, actor: LocalActor) => {
      if (assignment.placement._tag !== "LocalDevicePlacement")
        return Effect.fail(failure("fenced", "Assignment placement is not local"))
      if (assignment.placement.deviceId !== actor.deviceId)
        return Effect.fail(failure("fenced", "Authenticated device is not assigned to this executor"))
      if (!actor.organizationIds.includes(assignment.organizationId))
        return Effect.fail(failure("authentication", "Authenticated membership is not assigned to this executor"))
      return Effect.succeed(assignment.placement)
    }
    const verifyActor = Effect.fn("LocalExecutor.verifyActor")(function* (actor: LocalActor, organizationId: string) {
      if (!actor.organizationIds.includes(organizationId))
        return yield* failure("authentication", "Authenticated membership is unavailable")
      const valid = yield* sql<{ readonly clientId: string }>`SELECT registration.client_id AS "clientId"
        FROM rika_cli_registration registration
        JOIN member membership
          ON membership.user_id = registration.user_id
          AND membership.id = ${actor.memberId}
          AND membership.organization_id = ${organizationId}
        WHERE registration.client_id = ${actor.clientId}
          AND registration.device_id::text = ${actor.deviceId}
          AND registration.user_id = ${actor.userId}
          AND registration.revoked_at IS NULL
        LIMIT 1`.pipe(Effect.mapError(() => failure("repository", "Local device authority is unavailable")))
      if (valid.length === 0) return yield* failure("authentication", "Local device or membership is no longer active")
    })

    const actorFor = Effect.fn("LocalExecutor.actorFor")(function* (input: ProtocolAccess) {
      const rows = yield* sql<{
        readonly organizationId: string
        readonly deviceId: string
        readonly clientId: string
        readonly userId: string
        readonly memberId: string
      }>`SELECT organization_id AS "organizationId", device_id AS "deviceId", client_id AS "clientId", user_id AS "userId", member_id AS "memberId"
        FROM rika_hosted_local_executor_admissions
        WHERE assignment_id = ${input.fence.assignmentId} AND generation = ${input.fence.assignmentGeneration}
          AND device_id = ${input.fence.instanceId} AND process_incarnation = ${input.fence.processIncarnation}
          AND consumed_at IS NOT NULL
        ORDER BY consumed_at DESC LIMIT 1`.pipe(
        Effect.mapError(() => failure("repository", "Local admission binding is unavailable")),
      )
      const row = rows[0]
      if (row === undefined) return yield* failure("authentication", "Local admission binding is unavailable")
      return {
        organizationIds: [row.organizationId],
        deviceId: row.deviceId,
        clientId: row.clientId,
        userId: row.userId,
        memberId: row.memberId,
      } satisfies LocalActor
    })
    const access = Effect.fn("LocalExecutor.access")(function* (
      input: ProtocolAccess,
      actor: LocalActor,
    ): Effect.fn.Return<Access, ControllerError> {
      if (input.fence.target !== "local_device") return yield* failure("fenced", "Executor target is not local")
      const assignment = yield* load(input.fence.assignmentId)
      const placement = yield* local(assignment, actor)
      yield* verifyActor(actor, assignment.organizationId)
      if (number(assignment.generation) !== input.fence.assignmentGeneration)
        return yield* failure("fenced", "Assignment generation is stale")
      if (input.fence.instanceId !== placement.deviceId)
        return yield* failure("fenced", "Executor instance is not the assigned device")
      const admitted = yield* sql<{ readonly id: string }>`SELECT id FROM rika_hosted_local_executor_admissions
        WHERE assignment_id = ${assignment.id} AND organization_id = ${assignment.organizationId}
          AND device_id = ${actor.deviceId} AND client_id = ${actor.clientId}
          AND generation = ${assignment.generation} AND consumed_at IS NOT NULL
        LIMIT 1`.pipe(Effect.mapError(() => failure("repository", "Local admission binding is unavailable")))
      if (admitted.length === 0)
        return yield* failure("authentication", "Authenticated client has no consumed local admission")
      return {
        assignmentId: ExecutorAssignmentId.make(input.fence.assignmentId),
        assignmentGeneration: FencingGeneration.make(String(input.fence.assignmentGeneration)),
        providerInstanceId: placement.deviceId,
        executorInstanceId: ExecutorInstanceId.make(input.fence.executorId),
        processIncarnation: input.fence.processIncarnation,
        leaseEpoch: AssignmentLeaseEpoch.make(String(input.leaseEpoch)),
        presentedSessionCredentialDigest: yield* digest(Redacted.value(input.sessionToken)),
      }
    })

    const admit = Effect.fn("LocalExecutor.admit")(function* (input: Parameters<LocalExecutorAuthority["admit"]>[0]) {
      if (!input.actor.organizationIds.includes(input.organizationId))
        return yield* failure("authentication", "Authenticated membership is unavailable")
      const ticket = yield* secret("local-executor-ticket")
      const ticketDigest = yield* digest(Redacted.value(ticket))
      const admissionId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => failure("repository", "Admission ID issuance failed")),
      )
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* verifyActor(input.actor, input.organizationId)
            const assignment = yield* load(input.threadId)
            yield* local(assignment, input.actor)
            if (assignment.organizationId !== input.organizationId)
              return yield* failure("fenced", "Thread is outside the requested organization")

            let preparing: ExecutorAssignment
            if (assignment.lifecycle._tag === "Pending") {
              preparing = yield* assignments
                .beginProvisioning({
                  ...version(assignment),
                  bootstrapCredentialDigest: ticketDigest,
                  bootstrapLifetimeMillis: admissionLifetimeMillis,
                })
                .pipe(Effect.mapError(assignmentFailure))
            } else if (assignment.lifecycle._tag === "Active") {
              preparing = yield* assignments
                .beginReplacement({
                  ...version(assignment),
                  bootstrapCredentialDigest: ticketDigest,
                  bootstrapLifetimeMillis: admissionLifetimeMillis,
                })
                .pipe(Effect.mapError(assignmentFailure))
            } else if (
              assignment.lifecycle._tag === "Provisioning" ||
              assignment.lifecycle._tag === "AwaitingBootstrap"
            ) {
              preparing = yield* assignments
                .beginProvisioning({
                  ...version(assignment),
                  bootstrapCredentialDigest: ticketDigest,
                  bootstrapLifetimeMillis: admissionLifetimeMillis,
                })
                .pipe(Effect.mapError(assignmentFailure))
            } else if (assignment.lifecycle._tag === "Paused") {
              preparing = yield* assignments
                .resume({
                  ...version(assignment),
                  bootstrapCredentialDigest: ticketDigest,
                  bootstrapLifetimeMillis: admissionLifetimeMillis,
                })
                .pipe(Effect.mapError(assignmentFailure))
            } else {
              return yield* failure("fenced", "Local executor assignment is terminated")
            }

            const awaiting = yield* assignments
              .bindProviderInstance({ ...version(preparing), providerInstanceId: input.actor.deviceId })
              .pipe(Effect.mapError(assignmentFailure))
            const persisted = yield* sql<{
              readonly expiresAt: string
            }>`INSERT INTO rika_hosted_local_executor_admissions (
            id, assignment_id, organization_id, device_id, client_id, user_id, member_id, generation,
            workspace_fingerprint, ticket_digest, expires_at
          ) VALUES (
            ${admissionId}, ${awaiting.id}, ${awaiting.organizationId}, ${input.actor.deviceId},
            ${input.actor.clientId}, ${input.actor.userId}, ${input.actor.memberId}, ${awaiting.generation},
            ${input.workspaceFingerprint}, ${Redacted.value(ticketDigest)},
            clock_timestamp() + (${admissionLifetimeMillis} * interval '1 millisecond')
          )
          RETURNING extract(epoch FROM expires_at) * 1000 AS "expiresAt"`.pipe(
              Effect.mapError(() => failure("repository", "Local admission could not be persisted")),
            )
            const expiry = persisted[0]
            if (expiry === undefined) return yield* failure("repository", "Local admission expiry was not persisted")
            return {
              admissionId,
              ticket: Redacted.value(ticket),
              expiresAt: number(expiry.expiresAt),
              executorUrl: input.executorUrl,
              workspaceIdentity: input.workspaceFingerprint,
            }
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ControllerError" ? error : failure("repository", "Local executor transaction failed"),
          ),
        )
    })

    const hello = Effect.fn("LocalExecutor.hello")(function* (input: Parameters<LocalExecutorAuthority["hello"]>[0]) {
      const presented = yield* digest(input.ticket)
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<AdmissionRow & { readonly ticketDigest: string }>`SELECT
            id, assignment_id AS "assignmentId", organization_id AS "organizationId",
            device_id AS "deviceId", client_id AS "clientId", user_id AS "userId", member_id AS "memberId",
            generation::text AS generation, workspace_fingerprint AS "workspaceFingerprint",
            ticket_digest AS "ticketDigest",
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
            FROM rika_hosted_local_executor_admissions
            WHERE id = ${input.admissionId} AND consumed_at IS NULL
              AND expires_at > clock_timestamp()
            FOR UPDATE`.pipe(
              Effect.mapError(() => failure("authentication", "Local admission is invalid, expired, or consumed")),
            )
            const admission = rows[0]
            if (admission === undefined || admission.ticketDigest !== Redacted.value(presented))
              return yield* failure("authentication", "Local admission is invalid, expired, or consumed")
            const actor: LocalActor = {
              organizationIds: [admission.organizationId],
              deviceId: admission.deviceId,
              clientId: admission.clientId,
              userId: admission.userId,
              memberId: admission.memberId,
            }
            const assignment = yield* load(admission.assignmentId)
            const placement = yield* local(assignment, actor)
            yield* verifyActor(actor, assignment.organizationId)
            if (
              number(assignment.generation) !== number(admission.generation) ||
              assignment.lifecycle._tag !== "AwaitingBootstrap"
            )
              return yield* failure("fenced", "Local admission assignment is no longer current")
            if (assignment.lifecycle.providerInstanceId !== placement.deviceId)
              return yield* failure("fenced", "Local admission device binding is no longer current")
            const session = yield* secret("local-executor-session")
            const active = yield* assignments
              .openSession({
                ...version(assignment),
                providerInstanceId: placement.deviceId,
                executorInstanceId: ExecutorInstanceId.make(`${assignment.id}:g${assignment.generation}`),
                processIncarnation: input.processIncarnation,
                presentedBootstrapCredentialDigest: presented,
                sessionCredentialDigest: yield* digest(Redacted.value(session)),
                leaseLifetimeMillis,
              })
              .pipe(Effect.mapError(assignmentFailure))
            if (active.lifecycle._tag !== "Active")
              return yield* failure("repository", "Local executor session did not become active")
            const consumed = yield* sql`UPDATE rika_hosted_local_executor_admissions
            SET consumed_at = transaction_timestamp(), process_incarnation = ${input.processIncarnation}
            WHERE id = ${input.admissionId} AND consumed_at IS NULL AND expires_at > clock_timestamp()
            RETURNING id`.pipe(Effect.mapError(() => failure("repository", "Local admission could not be consumed")))
            if (consumed[0] === undefined)
              return yield* failure("authentication", "Local admission is invalid, expired, or consumed")
            return {
              version: 1 as const,
              fence: {
                target: "local_device" as const,
                assignmentId: active.id,
                assignmentGeneration: number(active.generation),
                instanceId: placement.deviceId,
                executorId: `${active.id}:g${active.generation}`,
                processIncarnation: input.processIncarnation,
              },
              sessionToken: session,
              leaseEpoch: number(active.lifecycle.leaseEpoch),
              leaseExpiresAt: epochMillis(active.lifecycle.leaseExpiresAt),
              heartbeatIntervalMillis,
              cursor: { sequence: number(active.cursor.sequence), value: active.cursor.value },
            }
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ControllerError" ? error : failure("repository", "Local executor transaction failed"),
          ),
        )
    })

    const validateAccess = Effect.fn("LocalExecutor.validateAccess")(function* (input: ProtocolAccess) {
      yield* assignments
        .authenticate(yield* access(input, yield* actorFor(input)))
        .pipe(Effect.mapError(assignmentFailure))
    })
    const workspaceIdentity = Effect.fn("LocalExecutor.workspaceIdentity")(function* (input: ProtocolAccess) {
      yield* validateAccess(input)
      const rows = yield* sql<{ readonly fingerprint: string }>`SELECT workspace_fingerprint AS fingerprint
        FROM rika_hosted_local_executor_admissions
        WHERE assignment_id = ${input.fence.assignmentId} AND generation = ${input.fence.assignmentGeneration}
          AND device_id = ${input.fence.instanceId} AND process_incarnation = ${input.fence.processIncarnation}
          AND consumed_at IS NOT NULL
        ORDER BY consumed_at DESC LIMIT 1`.pipe(
        Effect.mapError(() => failure("repository", "Local workspace identity is unavailable")),
      )
      if (rows[0] === undefined) return yield* failure("fenced", "Local workspace identity is unavailable")
      return rows[0].fingerprint
    })
    const reconnect = Effect.fn("LocalExecutor.reconnect")(function* (input: ProtocolAccess) {
      const persisted = yield* access(input, yield* actorFor(input))
      yield* assignments.authenticate(persisted).pipe(Effect.mapError(assignmentFailure))
      const active = yield* assignments
        .reconnect({ access: persisted, leaseLifetimeMillis })
        .pipe(Effect.mapError(assignmentFailure))
      if (active.lifecycle._tag !== "Active")
        return yield* failure("repository", "Local executor session is not active")
      return {
        version: 1 as const,
        fence: input.fence,
        leaseEpoch: number(active.lifecycle.leaseEpoch),
        leaseExpiresAt: epochMillis(active.lifecycle.leaseExpiresAt),
        heartbeatIntervalMillis,
        cursor: { sequence: number(active.cursor.sequence), value: active.cursor.value },
      }
    })
    const heartbeat = Effect.fn("LocalExecutor.heartbeat")(function* (input: Heartbeat) {
      const active = yield* assignments
        .heartbeat({
          access: yield* access(input.access, yield* actorFor(input.access)),
          leaseLifetimeMillis,
          cursor: { sequence: Sequence.make(String(input.cursor.sequence)), value: input.cursor.value },
        })
        .pipe(Effect.mapError(assignmentFailure))
      if (active.lifecycle._tag !== "Active")
        return yield* failure("repository", "Local executor session is not active")
      return {
        version: 1 as const,
        fence: input.access.fence,
        leaseEpoch: number(active.lifecycle.leaseEpoch),
        leaseExpiresAt: epochMillis(active.lifecycle.leaseExpiresAt),
        cursor: { sequence: number(active.cursor.sequence), value: active.cursor.value },
      }
    })
    const release = Effect.fn("LocalExecutor.release")(function* (input: ProtocolAccess) {
      yield* assignments
        .release(yield* access(input, yield* actorFor(input)))
        .pipe(Effect.mapError(assignmentFailure))
    })
    return LocalExecutor.of({ admit, hello, reconnect, validateAccess, workspaceIdentity, heartbeat, release })
  }),
)
