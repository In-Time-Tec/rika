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
  ThreadId,
} from "@rika/product/hosted-model"
import type { Access as ProtocolAccess, Heartbeat, RunnerHelloWire } from "@rika/remote-execution/protocol"
import type { AuthenticatedPrincipal } from "../hosted/product"

const leaseLifetimeMillis = 60_000
const heartbeatIntervalMillis = 20_000
const admissionLifetimeMillis = 60_000

export interface RunnerAdmission {
  readonly admissionId: string
  readonly ticket: string
  readonly expiresAt: number
  readonly executorUrl: string
  readonly workspaceIdentity: string
}

export interface RunnerExecutorAuthority {
  readonly admit: (input: {
    readonly threadId: string
    readonly workspaceFingerprint: string
    readonly principal: AuthenticatedPrincipal
    readonly executorUrl: string
  }) => Effect.Effect<RunnerAdmission, ControllerError>
  readonly hello: (input: RunnerHelloWire) => Effect.Effect<Welcome, ControllerError>
  readonly reconnect: (access: ProtocolAccess) => Effect.Effect<ReconnectWelcome, ControllerError>
  readonly validateAccess: (access: ProtocolAccess) => Effect.Effect<void, ControllerError>
  readonly workspaceIdentity: (access: ProtocolAccess) => Effect.Effect<string, ControllerError>
  readonly heartbeat: (heartbeat: Heartbeat) => Effect.Effect<Receipt, ControllerError>
  readonly release: (access: ProtocolAccess) => Effect.Effect<void, ControllerError>
}

export class RunnerExecutor extends Context.Service<RunnerExecutor, RunnerExecutorAuthority>()(
  "@rika/api/runner/executor/RunnerExecutor",
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
  readonly ownerId: string
  readonly deviceId: string
  readonly clientId: string
  readonly userId: string
  readonly generation: string
  readonly workspaceFingerprint: string
  readonly expiresAt: string
}

export const layer = Layer.effect(
  RunnerExecutor,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const assignments = yield* ExecutorAssignments
    const crypto = yield* Crypto.Crypto

    const digest = Effect.fn("RunnerExecutor.digest")(function* (secret: string) {
      const bytes = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(secret))
        .pipe(Effect.mapError(() => failure("authentication", "Credential verification failed")))
      return Redacted.make(Encoding.encodeHex(bytes), { label: "runner-ticket-digest" })
    })
    const secret = Effect.fn("RunnerExecutor.secret")(function* (label: string) {
      const bytes = yield* crypto
        .randomBytes(32)
        .pipe(Effect.mapError(() => failure("authentication", "Credential issuance failed")))
      return Redacted.make(Encoding.encodeBase64Url(bytes), { label })
    })
    const load = Effect.fn("RunnerExecutor.load")(function* (assignmentId: string) {
      const assignment = yield* assignments
        .get(ExecutorAssignmentId.make(assignmentId))
        .pipe(Effect.mapError(assignmentFailure))
      if (assignment === undefined) return yield* failure("assignment-missing", "Local assignment does not exist")
      return assignment
    })
    const loadForThread = Effect.fn("RunnerExecutor.loadForThread")(function* (threadId: string) {
      const assignment = yield* assignments
        .getForThread(ThreadId.make(threadId))
        .pipe(Effect.mapError(assignmentFailure))
      if (assignment === undefined) return yield* failure("assignment-missing", "Local assignment does not exist")
      return assignment
    })
    const local = (assignment: ExecutorAssignment, principal: AuthenticatedPrincipal) => {
      if (assignment.placement._tag !== "RunnerPlacement")
        return Effect.fail(failure("fenced", "Assignment placement is not local"))
      if (assignment.placement.deviceId !== principal.deviceId)
        return Effect.fail(failure("fenced", "Authenticated device is not assigned to this executor"))
      return Effect.succeed(assignment.placement)
    }
    const verifyPrincipal = Effect.fn("RunnerExecutor.verifyPrincipal")(function* (
      principal: AuthenticatedPrincipal,
      ownerId: string,
    ) {
      const valid = yield* sql<{ readonly ownerId: string }>`SELECT owner_record.id AS "ownerId"
        FROM rika_hosted_owners owner_record
        WHERE owner_record.id = ${ownerId}
          AND (
            (owner_record.kind = 'personal' AND owner_record.user_id = ${principal.userId})
            OR (owner_record.kind = 'organization' AND EXISTS (
              SELECT 1 FROM member membership
              WHERE membership.organization_id = owner_record.organization_id
                AND membership.user_id = ${principal.userId}
            ))
          )
          AND (
            EXISTS (
              SELECT 1 FROM rika_cli_registration registration
              WHERE registration.client_id = ${principal.clientId}
                AND registration.device_id::text = ${principal.deviceId}
                AND registration.user_id = ${principal.userId}
                AND registration.revoked_at IS NULL
                AND (${principal.dpopJkt ?? null}::text IS NULL OR registration.jwk_thumbprint = ${principal.dpopJkt ?? null})
            )
          )
        LIMIT 1`.pipe(Effect.mapError(() => failure("repository", "Local device authority is unavailable")))
      if (valid.length === 0)
        return yield* failure("authentication", "Local principal or owner authority is no longer active")
    })

    const principalFor = Effect.fn("RunnerExecutor.principalFor")(function* (input: ProtocolAccess) {
      const rows = yield* sql<{
        readonly deviceId: string
        readonly clientId: string
        readonly userId: string
      }>`SELECT device_id AS "deviceId", client_id AS "clientId", user_id AS "userId"
        FROM rika_hosted_runner_admissions
        WHERE assignment_id = ${input.fence.assignmentId} AND generation = ${input.fence.assignmentGeneration}
          AND device_id = ${input.fence.instanceId} AND process_incarnation = ${input.fence.processIncarnation}
          AND consumed_at IS NOT NULL AND revoked_at IS NULL
        ORDER BY consumed_at DESC LIMIT 1`.pipe(
        Effect.mapError(() => failure("repository", "Runner admission binding is unavailable")),
      )
      const row = rows[0]
      if (row === undefined) return yield* failure("authentication", "Runner admission binding is unavailable")
      return {
        deviceId: row.deviceId,
        clientId: row.clientId,
        userId: row.userId,
      } satisfies AuthenticatedPrincipal
    })
    const access = Effect.fn("RunnerExecutor.access")(function* (
      input: ProtocolAccess,
      principal: AuthenticatedPrincipal,
    ): Effect.fn.Return<Access, ControllerError> {
      if (input.fence.target !== "runner") return yield* failure("fenced", "Executor target is not local")
      const assignment = yield* load(input.fence.assignmentId)
      const placement = yield* local(assignment, principal)
      yield* verifyPrincipal(principal, assignment.ownerId)
      if (number(assignment.generation) !== input.fence.assignmentGeneration)
        return yield* failure("fenced", "Assignment generation is stale")
      if (input.fence.instanceId !== placement.deviceId)
        return yield* failure("fenced", "Executor instance is not the assigned device")
      const admitted = yield* sql<{ readonly id: string }>`SELECT id FROM rika_hosted_runner_admissions
        WHERE assignment_id = ${assignment.id} AND owner_id = ${assignment.ownerId}
          AND device_id = ${principal.deviceId} AND client_id = ${principal.clientId}
          AND generation = ${assignment.generation} AND consumed_at IS NOT NULL AND revoked_at IS NULL
        LIMIT 1`.pipe(Effect.mapError(() => failure("repository", "Runner admission binding is unavailable")))
      if (admitted.length === 0)
        return yield* failure("authentication", "Authenticated client has no consumed Runner admission")
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

    const admit = Effect.fn("RunnerExecutor.admit")(function* (input: Parameters<RunnerExecutorAuthority["admit"]>[0]) {
      const ticket = yield* secret("runner-ticket")
      const ticketDigest = yield* digest(Redacted.value(ticket))
      const admissionId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError(() => failure("repository", "Admission ID issuance failed")),
      )
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const assignment = yield* loadForThread(input.threadId)
            const placement = yield* local(assignment, input.principal)
            yield* verifyPrincipal(input.principal, assignment.ownerId)
            if (placement.checkoutFingerprint !== input.workspaceFingerprint)
              return yield* failure("fenced", "Authenticated checkout is not assigned to this executor")
            if (placement.requestingDeviceId !== placement.deviceId) {
              const allowed = yield* sql`SELECT device_id FROM rika_hosted_runner_registrations
                WHERE device_id = ${placement.deviceId} AND checkout_fingerprint = ${placement.checkoutFingerprint}
                  AND remote_thread_creation_allowed = TRUE FOR UPDATE`.pipe(
                Effect.mapError(() => failure("repository", "Runner preference is unavailable")),
              )
              if (allowed.length === 0) return yield* failure("fenced", "Remote Thread creation is no longer allowed")
            }

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
              return yield* failure("fenced", "Runner assignment is terminated")
            }

            const awaiting = yield* assignments
              .bindProviderInstance({ ...version(preparing), providerInstanceId: input.principal.deviceId })
              .pipe(Effect.mapError(assignmentFailure))
            const persisted = yield* sql<{
              readonly expiresAt: string
            }>`INSERT INTO rika_hosted_runner_admissions (
            id, assignment_id, owner_id, device_id, client_id, user_id, generation,
            workspace_fingerprint, ticket_digest, expires_at
          ) VALUES (
            ${admissionId}, ${awaiting.id}, ${awaiting.ownerId}, ${input.principal.deviceId},
            ${input.principal.clientId}, ${input.principal.userId}, ${awaiting.generation},
            ${input.workspaceFingerprint}, ${Redacted.value(ticketDigest)},
            clock_timestamp() + (${admissionLifetimeMillis} * interval '1 millisecond')
          )
          RETURNING extract(epoch FROM expires_at) * 1000 AS "expiresAt"`.pipe(
              Effect.mapError(() => failure("repository", "Runner admission could not be persisted")),
            )
            const expiry = persisted[0]
            if (expiry === undefined) return yield* failure("repository", "Runner admission expiry was not persisted")
            return {
              admissionId,
              ticket: Redacted.value(ticket),
              expiresAt: Math.floor(number(expiry.expiresAt)),
              executorUrl: input.executorUrl,
              workspaceIdentity: input.workspaceFingerprint,
            }
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ControllerError" ? error : failure("repository", "Runner transaction failed"),
          ),
        )
    })

    const hello = Effect.fn("RunnerExecutor.hello")(function* (input: Parameters<RunnerExecutorAuthority["hello"]>[0]) {
      const presented = yield* digest(input.ticket)
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<AdmissionRow & { readonly ticketDigest: string }>`SELECT
            id, assignment_id AS "assignmentId", owner_id AS "ownerId",
            device_id AS "deviceId", client_id AS "clientId", user_id AS "userId",
            generation::text AS generation, workspace_fingerprint AS "workspaceFingerprint",
            ticket_digest AS "ticketDigest",
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"
            FROM rika_hosted_runner_admissions
            WHERE id = ${input.admissionId} AND consumed_at IS NULL
              AND revoked_at IS NULL AND expires_at > clock_timestamp()
            FOR UPDATE`.pipe(
              Effect.mapError(() => failure("authentication", "Runner admission is invalid, expired, or consumed")),
            )
            const admission = rows[0]
            if (admission === undefined || admission.ticketDigest !== Redacted.value(presented))
              return yield* failure("authentication", "Runner admission is invalid, expired, or consumed")
            const principal: AuthenticatedPrincipal = {
              deviceId: admission.deviceId,
              clientId: admission.clientId,
              userId: admission.userId,
            }
            const assignment = yield* load(admission.assignmentId)
            const placement = yield* local(assignment, principal)
            if (assignment.ownerId !== admission.ownerId)
              return yield* failure("fenced", "Runner admission owner binding is no longer current")
            yield* verifyPrincipal(principal, assignment.ownerId)
            if (
              number(assignment.generation) !== number(admission.generation) ||
              assignment.lifecycle._tag !== "AwaitingBootstrap"
            )
              return yield* failure("fenced", "Runner admission assignment is no longer current")
            if (assignment.lifecycle.providerInstanceId !== placement.deviceId)
              return yield* failure("fenced", "Runner admission device binding is no longer current")
            const session = yield* secret("runner-session")
            const active = yield* assignments
              .openSession({
                ...version(assignment),
                providerInstanceId: placement.deviceId,
                executorInstanceId: ExecutorInstanceId.make(`${assignment.id}:g${assignment.generation}`),
                processIncarnation: input.processIncarnation,
                presentedBootstrapCredentialDigest: presented,
                sessionCredentialDigest: yield* digest(Redacted.value(session)),
                capabilities: input.workspaceCapabilities,
                leaseLifetimeMillis,
              })
              .pipe(Effect.mapError(assignmentFailure))
            if (active.lifecycle._tag !== "Active")
              return yield* failure("repository", "Runner session did not become active")
            const consumed = yield* sql`UPDATE rika_hosted_runner_admissions
            SET consumed_at = transaction_timestamp(), process_incarnation = ${input.processIncarnation}
            WHERE id = ${input.admissionId} AND consumed_at IS NULL AND expires_at > clock_timestamp()
            RETURNING id`.pipe(Effect.mapError(() => failure("repository", "Runner admission could not be consumed")))
            if (consumed[0] === undefined)
              return yield* failure("authentication", "Runner admission is invalid, expired, or consumed")
            return {
              version: 1 as const,
              fence: {
                target: "runner" as const,
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
            error._tag === "ControllerError" ? error : failure("repository", "Runner transaction failed"),
          ),
        )
    })

    const validateAccess = Effect.fn("RunnerExecutor.validateAccess")(function* (input: ProtocolAccess) {
      yield* assignments
        .authenticate(yield* access(input, yield* principalFor(input)))
        .pipe(Effect.mapError(assignmentFailure))
    })
    const workspaceIdentity = Effect.fn("RunnerExecutor.workspaceIdentity")(function* (input: ProtocolAccess) {
      yield* validateAccess(input)
      const rows = yield* sql<{ readonly fingerprint: string }>`SELECT workspace_fingerprint AS fingerprint
        FROM rika_hosted_runner_admissions
        WHERE assignment_id = ${input.fence.assignmentId} AND generation = ${input.fence.assignmentGeneration}
          AND device_id = ${input.fence.instanceId} AND process_incarnation = ${input.fence.processIncarnation}
          AND consumed_at IS NOT NULL AND revoked_at IS NULL
        ORDER BY consumed_at DESC LIMIT 1`.pipe(
        Effect.mapError(() => failure("repository", "Local workspace identity is unavailable")),
      )
      if (rows[0] === undefined) return yield* failure("fenced", "Local workspace identity is unavailable")
      return rows[0].fingerprint
    })
    const reconnect = Effect.fn("RunnerExecutor.reconnect")(function* (input: ProtocolAccess) {
      const persisted = yield* access(input, yield* principalFor(input))
      yield* assignments.authenticate(persisted).pipe(Effect.mapError(assignmentFailure))
      const active = yield* assignments
        .reconnect({ access: persisted, leaseLifetimeMillis })
        .pipe(Effect.mapError(assignmentFailure))
      if (active.lifecycle._tag !== "Active") return yield* failure("repository", "Runner session is not active")
      return {
        version: 1 as const,
        fence: input.fence,
        leaseEpoch: number(active.lifecycle.leaseEpoch),
        leaseExpiresAt: epochMillis(active.lifecycle.leaseExpiresAt),
        heartbeatIntervalMillis,
        cursor: { sequence: number(active.cursor.sequence), value: active.cursor.value },
      }
    })
    const heartbeat = Effect.fn("RunnerExecutor.heartbeat")(function* (input: Heartbeat) {
      const active = yield* assignments
        .heartbeat({
          access: yield* access(input.access, yield* principalFor(input.access)),
          leaseLifetimeMillis,
          cursor: { sequence: Sequence.make(String(input.cursor.sequence)), value: input.cursor.value },
        })
        .pipe(Effect.mapError(assignmentFailure))
      if (active.lifecycle._tag !== "Active") return yield* failure("repository", "Runner session is not active")
      return {
        version: 1 as const,
        fence: input.access.fence,
        leaseEpoch: number(active.lifecycle.leaseEpoch),
        leaseExpiresAt: epochMillis(active.lifecycle.leaseExpiresAt),
        cursor: { sequence: number(active.cursor.sequence), value: active.cursor.value },
      }
    })
    const release = Effect.fn("RunnerExecutor.release")(function* (input: ProtocolAccess) {
      yield* assignments
        .release(yield* access(input, yield* principalFor(input)))
        .pipe(Effect.mapError(assignmentFailure))
    })
    return RunnerExecutor.of({ admit, hello, reconnect, validateAccess, workspaceIdentity, heartbeat, release })
  }),
)
