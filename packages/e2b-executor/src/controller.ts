import {
  EmptyExecutorCursor,
  type ExecutorAccess,
  type ExecutorHeartbeat,
  type ExecutorHello,
  type FilesystemCheckpoint,
} from "@rika/remote-execution/protocol"
import { Clock, Context, Crypto, Effect, Encoding, Layer, Redacted } from "effect"
import { AssignmentStore, type AssignmentRecord, type AssignmentStoreError } from "./assignment-store"
import { CheckpointObjectInspector } from "./checkpoint"
import { CheckoutCredentialBroker } from "./checkout"
import {
  E2BExecutionError,
  type Assignment,
  type AssignmentKey,
  type AssignmentRequest,
  type CheckoutCredential,
  type ExecutorReconnectWelcome,
  type ExecutorWelcome,
  type LeaseReceipt,
  type VerifiedCheckpoint,
} from "./contract"
import { E2BSandboxProvider, type SandboxCreateRequest, type SandboxProviderError } from "./provider"

export const IdleTimeoutMillis = 15 * 60 * 1_000
export const DefaultHeartbeatIntervalMillis = 20_000
export const DefaultLeaseLifetimeMillis = 60_000
export const DefaultBootstrapLifetimeMillis = 5 * 60 * 1_000

export interface Options {
  readonly templateBuildId: string
  readonly controllerUrl: string
  readonly allowedEgress: ReadonlyArray<string>
  readonly idleTimeoutMillis?: number
  readonly heartbeatIntervalMillis?: number
  readonly leaseLifetimeMillis?: number
  readonly bootstrapLifetimeMillis?: number
}

export interface Interface {
  readonly assign: (request: AssignmentRequest) => Effect.Effect<Assignment, E2BExecutionError>
  readonly replace: (key: AssignmentKey) => Effect.Effect<Assignment, E2BExecutionError>
  readonly resume: (key: AssignmentKey) => Effect.Effect<Assignment, E2BExecutionError>
  readonly pause: (key: AssignmentKey) => Effect.Effect<Assignment, E2BExecutionError>
  readonly kill: (key: AssignmentKey) => Effect.Effect<Assignment, E2BExecutionError>
  readonly hello: (hello: ExecutorHello) => Effect.Effect<ExecutorWelcome, E2BExecutionError>
  readonly reconnect: (access: ExecutorAccess) => Effect.Effect<ExecutorReconnectWelcome, E2BExecutionError>
  readonly heartbeat: (heartbeat: ExecutorHeartbeat) => Effect.Effect<LeaseReceipt, E2BExecutionError>
  readonly checkpoint: (
    access: ExecutorAccess,
    checkpoint: FilesystemCheckpoint,
  ) => Effect.Effect<VerifiedCheckpoint, E2BExecutionError>
  readonly checkout: (access: ExecutorAccess) => Effect.Effect<CheckoutCredential, E2BExecutionError>
  readonly cleanupOrphans: Effect.Effect<ReadonlyArray<string>, E2BExecutionError>
}

export class E2BExecutionController extends Context.Service<E2BExecutionController, Interface>()(
  "@rika/e2b-executor/controller/E2BExecutionController",
) {}

const storeFailure = (cause: AssignmentStoreError) =>
  E2BExecutionError.make({ kind: storeFailureKind(cause), message: cause.message })

const storeFailureKind = (cause: AssignmentStoreError): E2BExecutionError["kind"] => {
  if (cause.kind === "missing") return "assignment-missing"
  if (cause.kind === "conflict") return "assignment-conflict"
  return "repository"
}

const providerFailure = (cause: SandboxProviderError) =>
  E2BExecutionError.make({ kind: "provider", message: `${cause.operation}: ${cause.message}` })

const failure = (kind: E2BExecutionError["kind"], message: string) => E2BExecutionError.make({ kind, message })

const publicAssignment = (record: AssignmentRecord): Assignment => ({
  assignmentId: record.assignmentId,
  workspaceId: record.workspaceId,
  generation: record.generation,
  templateBuildId: record.templateBuildId,
  ...(record.sandboxId === undefined ? {} : { sandboxId: record.sandboxId }),
  state: record.state,
  cursor: record.cursor,
})

const sameRequest = (record: AssignmentRecord, request: AssignmentRequest) =>
  record.workspaceId === request.workspaceId &&
  record.repository.owner === request.repository.owner &&
  record.repository.name === request.repository.name &&
  record.repository.installationId === request.repository.installationId &&
  record.repository.ref === request.repository.ref

const sameCheckpoint = (left: FilesystemCheckpoint, right: FilesystemCheckpoint) =>
  left.checkpointId === right.checkpointId &&
  left.objectKey === right.objectKey &&
  left.contentDigest === right.contentDigest &&
  left.sizeBytes === right.sizeBytes &&
  left.format === right.format &&
  left.cursor.sequence === right.cursor.sequence &&
  left.cursor.value === right.cursor.value

export const layer = (
  options: Options,
): Layer.Layer<
  E2BExecutionController,
  E2BExecutionError,
  AssignmentStore | CheckpointObjectInspector | CheckoutCredentialBroker | Crypto.Crypto | E2BSandboxProvider
> =>
  Layer.effect(
    E2BExecutionController,
    Effect.gen(function* () {
      if (options.templateBuildId.length === 0) return yield* failure("protocol", "Template build ID is required")
      if (
        options.allowedEgress.length === 0 ||
        options.allowedEgress.some((entry) => entry === "*" || entry === "0.0.0.0/0")
      )
        return yield* failure("protocol", "Egress allowlist must be constrained")
      const store = yield* AssignmentStore
      const provider = yield* E2BSandboxProvider
      const crypto = yield* Crypto.Crypto
      const checkpointInspector = yield* CheckpointObjectInspector
      const checkoutBroker = yield* CheckoutCredentialBroker
      const idleTimeoutMillis = options.idleTimeoutMillis ?? IdleTimeoutMillis
      const heartbeatIntervalMillis = options.heartbeatIntervalMillis ?? DefaultHeartbeatIntervalMillis
      const leaseLifetimeMillis = options.leaseLifetimeMillis ?? DefaultLeaseLifetimeMillis
      const bootstrapLifetimeMillis = options.bootstrapLifetimeMillis ?? DefaultBootstrapLifetimeMillis

      const digest = Effect.fn("E2BExecutionController.digest")(function* (secret: Redacted.Redacted<string>) {
        const bytes = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(Redacted.value(secret)))
          .pipe(Effect.mapError(() => failure("authentication", "Credential verification failed")))
        return Encoding.encodeHex(bytes)
      })

      const issueSecret = Effect.fn("E2BExecutionController.issueSecret")(function* (label: string) {
        const bytes = yield* crypto
          .randomBytes(32)
          .pipe(Effect.mapError(() => failure("authentication", "Credential issuance failed")))
        return Redacted.make(Encoding.encodeBase64Url(bytes), { label })
      })

      const load = Effect.fn("E2BExecutionController.load")(function* (assignmentId: string) {
        const record = yield* store.get(assignmentId).pipe(Effect.mapError(storeFailure))
        if (record === undefined)
          return yield* failure("assignment-missing", `Assignment ${assignmentId} does not exist`)
        return record
      })

      const current = Effect.fn("E2BExecutionController.current")(function* (key: AssignmentKey) {
        const record = yield* load(key.assignmentId)
        if (record.generation !== key.generation)
          return yield* failure("fenced", `Assignment ${key.assignmentId} generation ${key.generation} is stale`)
        if (record.state === "terminated")
          return yield* failure("fenced", `Assignment ${key.assignmentId} is terminated`)
        return record
      })

      const save = (record: AssignmentRecord, expectedRevision: number) =>
        store.update(record, expectedRevision).pipe(Effect.mapError(storeFailure))

      const bootstrap = Effect.fn("E2BExecutionController.bootstrap")(function* () {
        const token = yield* issueSecret("executor-bootstrap")
        return { token, digest: yield* digest(token) }
      })

      const createRequest = (record: AssignmentRecord, token: Redacted.Redacted<string>): SandboxCreateRequest => ({
        templateBuildId: record.templateBuildId,
        assignmentId: record.assignmentId,
        workspaceId: record.workspaceId,
        generation: record.generation,
        idleTimeoutMillis,
        allowedEgress: options.allowedEgress,
        environment: {
          RIKA_EXECUTOR_TARGET: "e2b",
          RIKA_EXECUTOR_ASSIGNMENT_ID: record.assignmentId,
          RIKA_EXECUTOR_GENERATION: String(record.generation),
          RIKA_EXECUTOR_ID: `${record.assignmentId}:g${record.generation}`,
          RIKA_EXECUTOR_CONTROLLER_URL: options.controllerUrl,
          RIKA_CHECKPOINT_OBJECT_PREFIX: `assignments/${record.assignmentId}/g${record.generation}/`,
        },
        secrets: { RIKA_EXECUTOR_BOOTSTRAP_TOKEN: token },
      })

      const provision = Effect.fn("E2BExecutionController.provision")(function* (
        pending: AssignmentRecord,
        token: Redacted.Redacted<string>,
      ) {
        const sandbox = yield* provider.create(createRequest(pending, token)).pipe(Effect.mapError(providerFailure))
        const active = yield* save(
          { ...pending, sandboxId: sandbox.sandboxId, state: "running" },
          pending.revision,
        ).pipe(Effect.tapError(() => provider.kill(sandbox.sandboxId).pipe(Effect.ignore)))
        return publicAssignment(active)
      })

      const authenticated = Effect.fn("E2BExecutionController.authenticated")(function* (
        access: ExecutorAccess,
        requireLiveLease: boolean,
      ) {
        if (access.fence.target !== "e2b") return yield* failure("fenced", "Executor target is not E2B")
        const record = yield* current({
          assignmentId: access.fence.assignmentId,
          generation: access.fence.generation,
        })
        if (
          record.sandboxId !== access.fence.instanceId ||
          record.executorId !== access.fence.executorId ||
          record.sessionDigest === undefined
        )
          return yield* failure("authentication", "Executor identity does not match the active assignment")
        if ((yield* digest(access.sessionToken)) !== record.sessionDigest)
          return yield* failure("authentication", "Executor session credential is invalid")
        const now = yield* Clock.currentTimeMillis
        if (requireLiveLease && (record.leaseExpiresAt === undefined || record.leaseExpiresAt <= now))
          return yield* failure("lease-expired", "Executor lease has expired")
        return { record, now }
      })

      const assign = Effect.fn("E2BExecutionController.assign")(function* (request: AssignmentRequest) {
        const existing = yield* store.get(request.assignmentId).pipe(Effect.mapError(storeFailure))
        if (existing !== undefined) {
          if (!sameRequest(existing, request))
            return yield* failure("assignment-conflict", `Assignment ${request.assignmentId} has different ownership`)
          if (existing.state === "provisioning" && existing.sandboxId === undefined) {
            const now = yield* Clock.currentTimeMillis
            const identity = yield* bootstrap()
            const refreshed = yield* save(
              {
                ...existing,
                bootstrapDigest: identity.digest,
                bootstrapExpiresAt: now + bootstrapLifetimeMillis,
                lastActiveAt: now,
              },
              existing.revision,
            )
            return yield* provision(refreshed, identity.token)
          }
          return publicAssignment(existing)
        }
        const now = yield* Clock.currentTimeMillis
        const identity = yield* bootstrap()
        const pending = yield* store
          .insert({
            assignmentId: request.assignmentId,
            workspaceId: request.workspaceId,
            repository: request.repository,
            generation: 1,
            templateBuildId: options.templateBuildId,
            state: "provisioning",
            bootstrapDigest: identity.digest,
            bootstrapExpiresAt: now + bootstrapLifetimeMillis,
            lastActiveAt: now,
            cursor: EmptyExecutorCursor,
            checkpoints: [],
            revision: 0,
          })
          .pipe(Effect.mapError(storeFailure))
        return yield* provision(pending, identity.token)
      })

      const replace = Effect.fn("E2BExecutionController.replace")(function* (key: AssignmentKey) {
        const previous = yield* current(key)
        const now = yield* Clock.currentTimeMillis
        const identity = yield* bootstrap()
        const replacing = yield* save(
          {
            assignmentId: previous.assignmentId,
            workspaceId: previous.workspaceId,
            repository: previous.repository,
            generation: previous.generation + 1,
            templateBuildId: options.templateBuildId,
            state: "replacing",
            ...(previous.sandboxId === undefined ? {} : { sandboxId: previous.sandboxId }),
            bootstrapDigest: identity.digest,
            bootstrapExpiresAt: now + bootstrapLifetimeMillis,
            lastActiveAt: now,
            cursor: previous.cursor,
            checkpoints: previous.checkpoints,
            revision: previous.revision,
          },
          previous.revision,
        )
        const sandbox = yield* provider
          .create(createRequest(replacing, identity.token))
          .pipe(Effect.mapError(providerFailure))
        const active = yield* save(
          {
            assignmentId: replacing.assignmentId,
            workspaceId: replacing.workspaceId,
            repository: replacing.repository,
            generation: replacing.generation,
            templateBuildId: replacing.templateBuildId,
            state: "running",
            sandboxId: sandbox.sandboxId,
            bootstrapDigest: replacing.bootstrapDigest,
            bootstrapExpiresAt: replacing.bootstrapExpiresAt,
            lastActiveAt: replacing.lastActiveAt,
            cursor: replacing.cursor,
            checkpoints: replacing.checkpoints,
            revision: replacing.revision,
          },
          replacing.revision,
        ).pipe(Effect.tapError(() => provider.kill(sandbox.sandboxId).pipe(Effect.ignore)))
        if (previous.sandboxId !== undefined) yield* provider.kill(previous.sandboxId).pipe(Effect.ignore)
        return publicAssignment(active)
      })

      const resume = Effect.fn("E2BExecutionController.resume")(function* (key: AssignmentKey) {
        const record = yield* current(key)
        if (record.sandboxId === undefined) return yield* failure("provider", "Assignment has no sandbox")
        yield* provider.connect(record.sandboxId, idleTimeoutMillis).pipe(Effect.mapError(providerFailure))
        if (record.state === "running") return publicAssignment(record)
        return publicAssignment(yield* save({ ...record, state: "running" }, record.revision))
      })

      const pause = Effect.fn("E2BExecutionController.pause")(function* (key: AssignmentKey) {
        const record = yield* current(key)
        if (record.sandboxId === undefined) return yield* failure("provider", "Assignment has no sandbox")
        yield* provider.pauseFilesystem(record.sandboxId).pipe(Effect.mapError(providerFailure))
        if (record.state === "paused") return publicAssignment(record)
        return publicAssignment(yield* save({ ...record, state: "paused" }, record.revision))
      })

      const kill = Effect.fn("E2BExecutionController.kill")(function* (key: AssignmentKey) {
        const record = yield* current(key)
        if (record.sandboxId !== undefined)
          yield* provider.kill(record.sandboxId).pipe(Effect.mapError(providerFailure))
        return publicAssignment(yield* save({ ...record, state: "terminated" }, record.revision))
      })

      const hello = Effect.fn("E2BExecutionController.hello")(function* (input: ExecutorHello) {
        if (input.fence.target !== "e2b") return yield* failure("fenced", "Executor target is not E2B")
        const record = yield* current({
          assignmentId: input.fence.assignmentId,
          generation: input.fence.generation,
        })
        const now = yield* Clock.currentTimeMillis
        if (record.state !== "running" || record.sandboxId !== input.fence.instanceId)
          return yield* failure("authentication", "Executor sandbox does not match the active assignment")
        if (record.bootstrapConsumedAt !== undefined || record.bootstrapExpiresAt <= now)
          return yield* failure("authentication", "Executor bootstrap credential is expired or consumed")
        if ((yield* digest(input.bootstrapToken)) !== record.bootstrapDigest)
          return yield* failure("authentication", "Executor bootstrap credential is invalid")
        const sessionToken = yield* issueSecret("executor-session")
        const leaseExpiresAt = now + leaseLifetimeMillis
        const active = yield* save(
          {
            ...record,
            executorId: input.fence.executorId,
            bootstrapConsumedAt: now,
            sessionDigest: yield* digest(sessionToken),
            leaseExpiresAt,
            lastActiveAt: now,
          },
          record.revision,
        )
        return {
          version: 1 as const,
          fence: input.fence,
          sessionToken,
          leaseExpiresAt,
          heartbeatIntervalMillis,
          cursor: active.cursor,
        }
      })

      const reconnect = Effect.fn("E2BExecutionController.reconnect")(function* (access: ExecutorAccess) {
        const { record, now } = yield* authenticated(access, false)
        const leaseExpiresAt = now + leaseLifetimeMillis
        const active = yield* save({ ...record, leaseExpiresAt, lastActiveAt: now, state: "running" }, record.revision)
        return {
          version: 1 as const,
          fence: access.fence,
          leaseExpiresAt,
          heartbeatIntervalMillis,
          cursor: active.cursor,
        }
      })

      const heartbeat = Effect.fn("E2BExecutionController.heartbeat")(function* (input: ExecutorHeartbeat) {
        const { record, now } = yield* authenticated(input.access, true)
        if (input.cursor.sequence < record.cursor.sequence)
          return yield* failure("protocol", "Executor cursor cannot move backwards")
        if (input.cursor.sequence === record.cursor.sequence && input.cursor.value !== record.cursor.value)
          return yield* failure("protocol", "Executor cursor value conflicts at the same sequence")
        const leaseExpiresAt = now + leaseLifetimeMillis
        const active = yield* save(
          { ...record, cursor: input.cursor, leaseExpiresAt, lastActiveAt: now, state: "running" },
          record.revision,
        )
        yield* provider.touch(input.access.fence.instanceId, idleTimeoutMillis).pipe(Effect.mapError(providerFailure))
        return { version: 1 as const, fence: input.access.fence, leaseExpiresAt, cursor: active.cursor }
      })

      const checkpoint = Effect.fn("E2BExecutionController.checkpoint")(function* (
        access: ExecutorAccess,
        staged: FilesystemCheckpoint,
      ) {
        const { record, now } = yield* authenticated(access, true)
        const expectedPrefix = `assignments/${record.assignmentId}/g${record.generation}/`
        if (!staged.objectKey.startsWith(expectedPrefix))
          return yield* failure("checkpoint", "Checkpoint object is outside the assignment prefix")
        if (staged.cursor.sequence !== record.cursor.sequence || staged.cursor.value !== record.cursor.value)
          return yield* failure("checkpoint", "Checkpoint cursor is not the acknowledged executor cursor")
        const existing = record.checkpoints.find(
          (entry) => entry.generation === record.generation && entry.checkpoint.checkpointId === staged.checkpointId,
        )
        if (existing !== undefined) {
          if (!sameCheckpoint(existing.checkpoint, staged))
            return yield* failure("checkpoint", "Checkpoint identifier conflicts with verified metadata")
          return existing
        }
        const inspected = yield* checkpointInspector
          .inspect(staged.objectKey)
          .pipe(Effect.mapError((cause) => failure("checkpoint", cause.message)))
        if (inspected.contentDigest !== staged.contentDigest || inspected.sizeBytes !== staged.sizeBytes)
          return yield* failure("checkpoint", "Checkpoint object digest or byte length did not verify")
        const verified: VerifiedCheckpoint = {
          assignmentId: record.assignmentId,
          generation: record.generation,
          sandboxId: access.fence.instanceId,
          checkpoint: staged,
          verifiedAt: now,
        }
        yield* save({ ...record, checkpoints: [...record.checkpoints, verified] }, record.revision)
        return verified
      })

      const checkout = Effect.fn("E2BExecutionController.checkout")(function* (access: ExecutorAccess) {
        const { record } = yield* authenticated(access, true)
        return yield* checkoutBroker
          .issue(record.repository)
          .pipe(Effect.mapError((cause) => failure("checkout", cause.message)))
      })

      const cleanupOrphans = Effect.gen(function* () {
        const assignments = yield* store.list.pipe(Effect.mapError(storeFailure))
        const active = new Set(
          assignments.flatMap((record) =>
            record.state === "terminated" || record.sandboxId === undefined ? [] : [record.sandboxId],
          ),
        )
        const inventory = yield* provider.inventory.pipe(Effect.mapError(providerFailure))
        const orphans = inventory
          .filter((sandbox) => !active.has(sandbox.sandboxId))
          .map((sandbox) => sandbox.sandboxId)
        yield* Effect.forEach(orphans, (sandboxId) => provider.kill(sandboxId).pipe(Effect.mapError(providerFailure)), {
          discard: true,
        })
        return orphans
      })

      return E2BExecutionController.of({
        assign,
        replace,
        resume,
        pause,
        kill,
        hello,
        reconnect,
        heartbeat,
        checkpoint,
        checkout,
        cleanupOrphans,
      })
    }),
  )
