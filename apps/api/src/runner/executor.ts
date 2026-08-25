import * as PgClient from "@effect/sql-pg/PgClient"
import { Context, Crypto, DateTime, Effect, Encoding, Layer, Redacted } from "effect"
import { ControllerError, type Receipt, type ReconnectWelcome, type Welcome } from "@rika/e2b-executor/controller"
import { type ExecutorAssignment } from "@rika/product/executor-assignment"
import { AssignmentError, ExecutorAssignments, type Access } from "@rika/product/executor-assignments"
import {
  HostedExecutionOperations,
  layer as hostedExecutionOperationsLayer,
} from "@rika/product-store/executor-operations"
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
  readonly assignmentId: ExecutorAssignmentId
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

const runnerExecutorLayer = Layer.effect(
  RunnerExecutor,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const assignments = yield* ExecutorAssignments
    const operations = yield* HostedExecutionOperations
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
      const valid = yield* operations
        .verifyRunnerAuthority({ ownerId, ...principal })
        .pipe(Effect.mapError(() => failure("repository", "Local device authority is unavailable")))
      if (!valid)
        return yield* failure("authentication", "Local principal or owner authority is no longer active")
    })

    const principalFor = Effect.fn("RunnerExecutor.principalFor")(function* (input: ProtocolAccess) {
      const principal = yield* operations
        .runnerPrincipal({
          assignmentId: input.fence.assignmentId,
          generation: input.fence.assignmentGeneration,
          deviceId: input.fence.instanceId,
          processIncarnation: input.fence.processIncarnation,
        })
        .pipe(
        Effect.mapError(() => failure("repository", "Runner admission binding is unavailable")),
      )
      if (principal === undefined)
        return yield* failure("authentication", "Runner admission binding is unavailable")
      return principal satisfies AuthenticatedPrincipal
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
      const admitted = yield* operations
        .hasConsumedRunnerAdmission({
          assignmentId: assignment.id,
          ownerId: assignment.ownerId,
          generation: number(assignment.generation),
          deviceId: principal.deviceId,
          clientId: principal.clientId,
        })
        .pipe(Effect.mapError(() => failure("repository", "Runner admission binding is unavailable")))
      if (!admitted)
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
              const allowed = yield* operations
                .lockRemoteCreationAdmission(placement.deviceId, placement.checkoutFingerprint)
                .pipe(
                Effect.mapError(() => failure("repository", "Runner preference is unavailable")),
              )
              if (!allowed) return yield* failure("fenced", "Remote Thread creation is no longer allowed")
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
            const expiresAt = yield* operations
              .createRunnerAdmission({
                id: admissionId,
                assignmentId: awaiting.id,
                ownerId: awaiting.ownerId,
                deviceId: input.principal.deviceId,
                clientId: input.principal.clientId,
                userId: input.principal.userId,
                generation: number(awaiting.generation),
                workspaceFingerprint: input.workspaceFingerprint,
                ticketDigest: Redacted.value(ticketDigest),
                lifetimeMillis: admissionLifetimeMillis,
              })
              .pipe(
              Effect.mapError(() => failure("repository", "Runner admission could not be persisted")),
            )
            return {
              assignmentId: awaiting.id,
              admissionId,
              ticket: Redacted.value(ticket),
              expiresAt: Math.floor(expiresAt),
              executorUrl: input.executorUrl,
              workspaceIdentity: awaiting.workspaceId,
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
            const admission = yield* operations.lockRunnerAdmission(input.admissionId).pipe(
              Effect.mapError(() => failure("authentication", "Runner admission is invalid, expired, or consumed")),
            )
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
              number(assignment.generation) !== admission.generation ||
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
            const consumed = yield* operations.consumeRunnerAdmission(input.admissionId, input.processIncarnation).pipe(
              Effect.mapError(() => failure("repository", "Runner admission could not be consumed")),
            )
            if (!consumed)
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
      return (yield* load(input.fence.assignmentId)).workspaceId
    })
    const reconnect = Effect.fn("RunnerExecutor.reconnect")(function* (input: ProtocolAccess) {
      const persisted = yield* access(input, yield* principalFor(input))
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

export const layer = runnerExecutorLayer.pipe(Layer.provide(hostedExecutionOperationsLayer))
