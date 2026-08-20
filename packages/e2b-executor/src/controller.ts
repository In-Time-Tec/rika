import { type ExecutorAssignment, type E2BPlacement } from "@rika/product/executor-assignment"
import { AssignmentError, ExecutorAssignments, type Access } from "@rika/product/executor-assignments"
import {
  AssignmentLeaseEpoch,
  CheckpointId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  Sequence,
} from "@rika/product/hosted-model"
import {
  type Access as ProtocolAccess,
  type Cursor,
  type Fence,
  type FilesystemCheckpoint,
  type Heartbeat,
  type Hello,
} from "@rika/remote-execution/protocol"
import { Context, Crypto, DateTime, Effect, Encoding, Layer, Redacted, Schema } from "effect"
import { Inspector } from "./checkpoint"
import { Credentials, type Credential } from "./checkout"
import { Provider, type CreateRequest, type ProviderError } from "./provider"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const AssignmentKey = Schema.Struct({ assignmentId: Identifier, generation: Generation })
export type AssignmentKey = typeof AssignmentKey.Type

export interface Assignment {
  readonly assignmentId: string
  readonly threadId: string
  readonly generation: number
  readonly templateBuildId: string
  readonly sandboxId?: string
  readonly state: "provisioning" | "running" | "paused" | "terminated"
  readonly cursor: Cursor
}

export interface VerifiedCheckpoint {
  readonly assignmentId: string
  readonly generation: number
  readonly sandboxId: string
  readonly checkpoint: FilesystemCheckpoint
  readonly verifiedAt: number
}

export interface Welcome {
  readonly version: 1
  readonly fence: Fence
  readonly sessionToken: Redacted.Redacted<string>
  readonly leaseEpoch: number
  readonly leaseExpiresAt: number
  readonly heartbeatIntervalMillis: number
  readonly cursor: Cursor
}

export interface ReconnectWelcome {
  readonly version: 1
  readonly fence: Fence
  readonly leaseEpoch: number
  readonly leaseExpiresAt: number
  readonly heartbeatIntervalMillis: number
  readonly cursor: Cursor
}

export interface Receipt {
  readonly version: 1
  readonly fence: Fence
  readonly leaseEpoch: number
  readonly leaseExpiresAt: number
  readonly cursor: Cursor
}

export class ControllerError extends Schema.TaggedError<ControllerError>()("ControllerError", {
  kind: Schema.Literals([
    "assignment-conflict",
    "assignment-missing",
    "authentication",
    "checkpoint",
    "checkout",
    "fenced",
    "lease-expired",
    "provider",
    "protocol",
    "repository",
  ]),
  message: Schema.String,
}) {}

export const IdleTimeoutMillis = 15 * 60 * 1_000
export const DefaultHeartbeatIntervalMillis = 20_000
export const DefaultLeaseLifetimeMillis = 60_000
export const DefaultBootstrapLifetimeMillis = 5 * 60 * 1_000

export interface Options {
  readonly appId: string
  readonly deploymentId: string
  readonly templateId: string
  readonly templateBuildId: string
  readonly apiUrl: string
  readonly allowedEgress: ReadonlyArray<string>
  readonly idleTimeoutMillis?: number
  readonly heartbeatIntervalMillis?: number
  readonly leaseLifetimeMillis?: number
  readonly bootstrapLifetimeMillis?: number
}

export interface Interface {
  readonly provision: (assignmentId: string) => Effect.Effect<Assignment, ControllerError>
  readonly replace: (key: AssignmentKey) => Effect.Effect<Assignment, ControllerError>
  readonly resume: (key: AssignmentKey) => Effect.Effect<Assignment, ControllerError>
  readonly pause: (key: AssignmentKey) => Effect.Effect<Assignment, ControllerError>
  readonly kill: (key: AssignmentKey) => Effect.Effect<Assignment, ControllerError>
  readonly hello: (hello: Hello) => Effect.Effect<Welcome, ControllerError>
  readonly reconnect: (access: ProtocolAccess) => Effect.Effect<ReconnectWelcome, ControllerError>
  readonly validateAccess: (access: ProtocolAccess) => Effect.Effect<void, ControllerError>
  readonly heartbeat: (heartbeat: Heartbeat) => Effect.Effect<Receipt, ControllerError>
  readonly checkpoint: (
    access: ProtocolAccess,
    checkpoint: FilesystemCheckpoint,
  ) => Effect.Effect<VerifiedCheckpoint, ControllerError>
  readonly checkout: (access: ProtocolAccess) => Effect.Effect<Credential, ControllerError>
  readonly cleanupOrphans: Effect.Effect<ReadonlyArray<string>, ControllerError>
}

export class Controller extends Context.Service<Controller, Interface>()("@rika/e2b-executor/controller") {}

const assignmentFailureKind = (cause: AssignmentError): ControllerError["kind"] => {
  if (cause.reason === "not-found") return "assignment-missing"
  if (cause.reason === "stale-fence") return "fenced"
  if (cause.reason === "authentication") return "authentication"
  if (cause.reason === "database") return "repository"
  return "assignment-conflict"
}

const assignmentFailure = (cause: AssignmentError) =>
  ControllerError.make({ kind: assignmentFailureKind(cause), message: cause.message })

const providerFailure = (cause: ProviderError) =>
  ControllerError.make({ kind: "provider", message: `${cause.operation}: ${cause.message}` })

const failure = (kind: ControllerError["kind"], message: string) => ControllerError.make({ kind, message })
const epochMillis = (value: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(value))
const number = (value: string) => Number(value)

const e2bPlacement = (assignment: ExecutorAssignment): Effect.Effect<E2BPlacement, ControllerError> =>
  assignment.placement._tag === "E2BPlacement"
    ? Effect.succeed(assignment.placement)
    : Effect.fail(failure("fenced", "Assignment placement is not E2B"))

const providerInstanceId = (assignment: ExecutorAssignment): string | undefined => {
  const lifecycle = assignment.lifecycle
  if (
    lifecycle._tag === "Provisioning" ||
    lifecycle._tag === "AwaitingBootstrap" ||
    lifecycle._tag === "Active" ||
    lifecycle._tag === "Paused"
  )
    return lifecycle.providerInstanceId ?? undefined
  return undefined
}

const publicAssignment = (assignment: ExecutorAssignment): Assignment => {
  const lifecycle = assignment.lifecycle
  let state: Assignment["state"] = "provisioning"
  if (lifecycle._tag === "Active") state = "running"
  if (lifecycle._tag === "Paused") state = "paused"
  if (lifecycle._tag === "Terminated") state = "terminated"
  const templateBuildId = assignment.placement._tag === "E2BPlacement" ? assignment.placement.templateBuildId : ""
  const sandboxId = providerInstanceId(assignment)
  return {
    assignmentId: assignment.id,
    threadId: assignment.threadId,
    generation: number(assignment.generation),
    templateBuildId,
    ...(sandboxId === undefined ? {} : { sandboxId }),
    state,
    cursor: { sequence: number(assignment.cursor.sequence), value: assignment.cursor.value },
  }
}

const version = (assignment: ExecutorAssignment) => ({
  assignmentId: assignment.id,
  generation: assignment.generation,
  revision: assignment.revision,
})

export const layer = (
  options: Options,
): Layer.Layer<Controller, ControllerError, Inspector | Credentials | Crypto.Crypto | Provider | ExecutorAssignments> =>
  Layer.effect(
    Controller,
    Effect.gen(function* () {
      if (options.templateId.length === 0) return yield* failure("protocol", "Template ID is required")
      if (options.templateBuildId.length === 0) return yield* failure("protocol", "Template build ID is required")
      if (
        options.allowedEgress.length === 0 ||
        options.allowedEgress.some((entry) => entry === "*" || entry === "0.0.0.0/0")
      )
        return yield* failure("protocol", "Egress allowlist must be constrained")
      const assignments = yield* ExecutorAssignments
      const provider = yield* Provider
      const crypto = yield* Crypto.Crypto
      const checkpointInspector = yield* Inspector
      const checkoutBroker = yield* Credentials
      const idleTimeoutMillis = options.idleTimeoutMillis ?? IdleTimeoutMillis
      const heartbeatIntervalMillis = options.heartbeatIntervalMillis ?? DefaultHeartbeatIntervalMillis
      const leaseLifetimeMillis = options.leaseLifetimeMillis ?? DefaultLeaseLifetimeMillis
      const bootstrapLifetimeMillis = options.bootstrapLifetimeMillis ?? DefaultBootstrapLifetimeMillis

      const digest = Effect.fn("Controller.digest")(function* (secret: Redacted.Redacted<string>) {
        const bytes = yield* crypto
          .digest("SHA-256", new TextEncoder().encode(Redacted.value(secret)))
          .pipe(Effect.mapError(() => failure("authentication", "Credential verification failed")))
        return Redacted.make(Encoding.encodeHex(bytes), { label: "credential-digest" })
      })

      const issueSecret = Effect.fn("Controller.issueSecret")(function* (label: string) {
        const bytes = yield* crypto
          .randomBytes(32)
          .pipe(Effect.mapError(() => failure("authentication", "Credential issuance failed")))
        return Redacted.make(Encoding.encodeBase64Url(bytes), { label })
      })

      const load = Effect.fn("Controller.load")(function* (assignmentId: string) {
        const assignment = yield* assignments
          .get(ExecutorAssignmentId.make(assignmentId))
          .pipe(Effect.mapError(assignmentFailure))
        if (assignment === undefined)
          return yield* failure("assignment-missing", `Assignment ${assignmentId} does not exist`)
        return assignment
      })

      const current = Effect.fn("Controller.current")(function* (key: AssignmentKey) {
        const assignment = yield* load(key.assignmentId)
        if (number(assignment.generation) !== key.generation)
          return yield* failure("fenced", `Assignment ${key.assignmentId} generation ${key.generation} is stale`)
        if (assignment.lifecycle._tag === "Terminated")
          return yield* failure("fenced", `Assignment ${key.assignmentId} is terminated`)
        return assignment
      })

      const createRequest = Effect.fn("Controller.createRequest")(function* (assignment: ExecutorAssignment) {
        const placement = yield* e2bPlacement(assignment)
        const request: CreateRequest = {
          appId: options.appId,
          deploymentId: options.deploymentId,
          templateId: options.templateId,
          templateBuildId: placement.templateBuildId,
          assignmentId: assignment.id,
          threadId: assignment.threadId,
          generation: number(assignment.generation),
          idleTimeoutMillis,
          allowedEgress: options.allowedEgress,
          environment: {
            RIKA_EXECUTOR_TARGET: "e2b",
            RIKA_EXECUTOR_ASSIGNMENT_ID: assignment.id,
            RIKA_EXECUTOR_GENERATION: assignment.generation,
            RIKA_EXECUTOR_ID: `${assignment.id}:g${assignment.generation}`,
            RIKA_EXECUTOR_TEMPLATE_BUILD_ID: placement.templateBuildId,
            RIKA_EXECUTOR_API_URL: options.apiUrl,
            RIKA_EXECUTOR_WORKSPACE: "/workspace",
            RIKA_CHECKPOINT_OBJECT_PREFIX: `assignments/${assignment.id}/g${assignment.generation}/`,
          },
        }
        return request
      })

      const matchesGeneration = (
        assignment: ExecutorAssignment,
        templateId: string,
        templateBuildId: string,
        metadata: Readonly<Record<string, string>>,
      ) =>
        metadata["rika.app-id"] === options.appId &&
        metadata["rika.deployment-id"] === options.deploymentId &&
        metadata["rika.assignment-id"] === assignment.id &&
        metadata["rika.generation"] === assignment.generation &&
        assignment.placement._tag === "E2BPlacement" &&
        templateId === options.templateId &&
        templateBuildId === assignment.placement.templateBuildId

      const reconcileCreate = Effect.fn("Controller.reconcileCreate")(function* (assignment: ExecutorAssignment) {
        const inventory = yield* provider.inventory.pipe(Effect.mapError(providerFailure))
        const matches = inventory.filter((entry) =>
          matchesGeneration(assignment, entry.templateId, entry.templateBuildId, entry.metadata),
        )
        if (matches.length === 0) return yield* failure("provider", "create outcome is unknown and no sandbox exists")
        const [adopt, ...duplicates] = [...matches].sort((left, right) => left.sandboxId.localeCompare(right.sandboxId))
        yield* Effect.forEach(
          duplicates,
          (entry) => provider.kill(entry.sandboxId).pipe(Effect.mapError(providerFailure)),
          { discard: true },
        )
        return adopt!
      })

      const createAndBootstrap = Effect.fn("Controller.createAndBootstrap")(function* (
        provisioning: ExecutorAssignment,
        credential: Redacted.Redacted<string>,
      ) {
        if (provisioning.lifecycle._tag !== "Provisioning")
          return yield* failure("assignment-conflict", "Assignment is not provisioning")
        const existingProviderId = provisioning.lifecycle.providerInstanceId
        const sandbox =
          existingProviderId === null
            ? yield* provider
                .create(yield* createRequest(provisioning))
                .pipe(Effect.catch(() => reconcileCreate(provisioning)))
            : yield* provider.connect(existingProviderId, idleTimeoutMillis).pipe(Effect.mapError(providerFailure))
        const bound = yield* assignments
          .bindProviderInstance({
            ...version(provisioning),
            providerInstanceId: sandbox.sandboxId,
          })
          .pipe(
            Effect.mapError(assignmentFailure),
            Effect.tapError(() =>
              existingProviderId === null ? provider.kill(sandbox.sandboxId).pipe(Effect.ignore) : Effect.void,
            ),
          )
        yield* provider.bootstrap({ sandboxId: sandbox.sandboxId, credential }).pipe(Effect.mapError(providerFailure))
        return publicAssignment(bound)
      })

      const beginProvisioning = Effect.fn("Controller.beginProvisioning")(function* (assignment: ExecutorAssignment) {
        const credential = yield* issueSecret("executor-bootstrap")
        const provisioning = yield* assignments
          .beginProvisioning({
            ...version(assignment),
            bootstrapCredentialDigest: yield* digest(credential),
            bootstrapLifetimeMillis,
          })
          .pipe(Effect.mapError(assignmentFailure))
        return yield* createAndBootstrap(provisioning, credential)
      })

      const resumeAssignment = Effect.fn("Controller.resumeAssignment")(function* (assignment: ExecutorAssignment) {
        const credential = yield* issueSecret("executor-bootstrap")
        const provisioning = yield* assignments
          .resume({
            ...version(assignment),
            bootstrapCredentialDigest: yield* digest(credential),
            bootstrapLifetimeMillis,
          })
          .pipe(Effect.mapError(assignmentFailure))
        return yield* createAndBootstrap(provisioning, credential)
      })

      const provision = Effect.fn("Controller.provision")(function* (assignmentId: string) {
        const assignment = yield* load(assignmentId)
        yield* e2bPlacement(assignment)
        if (assignment.lifecycle._tag === "Active") {
          yield* provider
            .connect(assignment.lifecycle.providerInstanceId, idleTimeoutMillis)
            .pipe(Effect.mapError(providerFailure))
          return publicAssignment(assignment)
        }
        if (assignment.lifecycle._tag === "Paused") return yield* resumeAssignment(assignment)
        if (assignment.lifecycle._tag === "Terminated")
          return yield* failure("fenced", `Assignment ${assignmentId} is terminated`)
        return yield* beginProvisioning(assignment)
      })

      const replace = Effect.fn("Controller.replace")(function* (key: AssignmentKey) {
        const previous = yield* current(key)
        if (previous.lifecycle._tag !== "Active")
          return yield* failure("assignment-conflict", "Only an active assignment can be replaced")
        const retiringProviderId = providerInstanceId(previous)
        const identity = yield* issueSecret("executor-bootstrap")
        const replacing = yield* assignments
          .beginReplacement({
            ...version(previous),
            bootstrapCredentialDigest: yield* digest(identity),
            bootstrapLifetimeMillis,
          })
          .pipe(Effect.mapError(assignmentFailure))
        const replacement = yield* createAndBootstrap(replacing, identity)
        if (retiringProviderId !== undefined) yield* provider.kill(retiringProviderId).pipe(Effect.ignore)
        return replacement
      })

      const resume = Effect.fn("Controller.resume")(function* (key: AssignmentKey) {
        const assignment = yield* current(key)
        if (assignment.lifecycle._tag === "Active") return publicAssignment(assignment)
        if (assignment.lifecycle._tag !== "Paused")
          return yield* failure("assignment-conflict", "Assignment is not paused")
        return yield* resumeAssignment(assignment)
      })

      const pause = Effect.fn("Controller.pause")(function* (key: AssignmentKey) {
        const assignment = yield* current(key)
        if (assignment.lifecycle._tag === "Paused") {
          yield* provider
            .pauseFilesystem(assignment.lifecycle.providerInstanceId)
            .pipe(Effect.mapError(providerFailure))
          return publicAssignment(assignment)
        }
        if (assignment.lifecycle._tag !== "Active")
          return yield* failure("assignment-conflict", "Only an active assignment can pause")
        const paused = yield* assignments.pause(version(assignment)).pipe(Effect.mapError(assignmentFailure))
        yield* provider.pauseFilesystem(assignment.lifecycle.providerInstanceId).pipe(Effect.mapError(providerFailure))
        return publicAssignment(paused)
      })

      const kill = Effect.fn("Controller.kill")(function* (key: AssignmentKey) {
        const assignment = yield* current(key)
        const sandboxId = providerInstanceId(assignment)
        if (sandboxId !== undefined) yield* provider.kill(sandboxId).pipe(Effect.mapError(providerFailure))
        return publicAssignment(
          yield* assignments.terminate(version(assignment)).pipe(Effect.mapError(assignmentFailure)),
        )
      })

      const assignmentAccess = Effect.fn("Controller.assignmentAccess")(function* (
        input: ProtocolAccess,
      ): Effect.fn.Return<Access, ControllerError> {
        if (input.fence.target !== "e2b") return yield* failure("fenced", "Executor target is not E2B")
        return {
          assignmentId: ExecutorAssignmentId.make(input.fence.assignmentId),
          assignmentGeneration: FencingGeneration.make(String(input.fence.assignmentGeneration)),
          providerInstanceId: input.fence.instanceId,
          executorInstanceId: ExecutorInstanceId.make(input.fence.executorId),
          processIncarnation: input.fence.processIncarnation,
          leaseEpoch: AssignmentLeaseEpoch.make(String(input.leaseEpoch)),
          presentedSessionCredentialDigest: yield* digest(input.sessionToken),
        }
      })

      const hello = Effect.fn("Controller.hello")(function* (input: Hello) {
        if (input.fence.target !== "e2b") return yield* failure("fenced", "Executor target is not E2B")
        const assignment = yield* current({
          assignmentId: input.fence.assignmentId,
          generation: input.fence.assignmentGeneration,
        })
        const placement = yield* e2bPlacement(assignment)
        const lifecycle = assignment.lifecycle
        const sessionToken = Redacted.make(Redacted.value(input.bootstrapToken), { label: "executor-session" })
        let active: ExecutorAssignment
        if (
          lifecycle._tag === "Active" &&
          lifecycle.providerInstanceId === input.fence.instanceId &&
          lifecycle.executorInstanceId === input.fence.executorId &&
          lifecycle.processIncarnation === input.fence.processIncarnation &&
          input.templateBuildId === placement.templateBuildId
        ) {
          active = yield* assignments
            .authenticate({
              assignmentId: assignment.id,
              assignmentGeneration: assignment.generation,
              providerInstanceId: lifecycle.providerInstanceId,
              executorInstanceId: lifecycle.executorInstanceId,
              processIncarnation: lifecycle.processIncarnation,
              leaseEpoch: lifecycle.leaseEpoch,
              presentedSessionCredentialDigest: yield* digest(sessionToken),
            })
            .pipe(Effect.mapError(assignmentFailure))
        } else {
          if (
            lifecycle._tag !== "AwaitingBootstrap" ||
            lifecycle.providerInstanceId !== input.fence.instanceId ||
            input.templateBuildId !== placement.templateBuildId
          )
            return yield* failure("authentication", "Executor sandbox does not match the active assignment")
          active = yield* assignments
            .openSession({
              ...version(assignment),
              providerInstanceId: input.fence.instanceId,
              executorInstanceId: ExecutorInstanceId.make(input.fence.executorId),
              processIncarnation: input.fence.processIncarnation,
              presentedBootstrapCredentialDigest: yield* digest(sessionToken),
              sessionCredentialDigest: yield* digest(sessionToken),
              leaseLifetimeMillis,
            })
            .pipe(Effect.mapError(assignmentFailure))
        }
        if (active.lifecycle._tag !== "Active")
          return yield* failure("repository", "Executor session did not become active")
        return {
          version: 1 as const,
          fence: input.fence,
          leaseEpoch: number(active.lifecycle.leaseEpoch),
          sessionToken,
          leaseExpiresAt: epochMillis(active.lifecycle.leaseExpiresAt),
          heartbeatIntervalMillis,
          cursor: { sequence: number(active.cursor.sequence), value: active.cursor.value },
        }
      })

      const reconnect = Effect.fn("Controller.reconnect")(function* (input: ProtocolAccess) {
        const active = yield* assignments
          .reconnect({ access: yield* assignmentAccess(input), leaseLifetimeMillis })
          .pipe(Effect.mapError(assignmentFailure))
        if (active.lifecycle._tag !== "Active") return yield* failure("repository", "Executor session is not active")
        return {
          version: 1 as const,
          fence: input.fence,
          leaseEpoch: number(active.lifecycle.leaseEpoch),
          leaseExpiresAt: epochMillis(active.lifecycle.leaseExpiresAt),
          heartbeatIntervalMillis,
          cursor: { sequence: number(active.cursor.sequence), value: active.cursor.value },
        }
      })

      const validateAccess = Effect.fn("Controller.validateAccess")(function* (input: ProtocolAccess) {
        yield* assignments.authenticate(yield* assignmentAccess(input)).pipe(Effect.mapError(assignmentFailure))
      })

      const heartbeat = Effect.fn("Controller.heartbeat")(function* (input: Heartbeat) {
        const active = yield* assignments
          .heartbeat({
            access: yield* assignmentAccess(input.access),
            leaseLifetimeMillis,
            cursor: { sequence: Sequence.make(String(input.cursor.sequence)), value: input.cursor.value },
          })
          .pipe(
            Effect.mapError((cause) =>
              cause.reason === "conflict" ? failure("protocol", cause.message) : assignmentFailure(cause),
            ),
          )
        if (active.lifecycle._tag !== "Active") return yield* failure("repository", "Executor session is not active")
        yield* provider
          .touch(active.lifecycle.providerInstanceId, idleTimeoutMillis)
          .pipe(Effect.mapError(providerFailure))
        return {
          version: 1 as const,
          fence: input.access.fence,
          leaseEpoch: number(active.lifecycle.leaseEpoch),
          leaseExpiresAt: epochMillis(active.lifecycle.leaseExpiresAt),
          cursor: { sequence: number(active.cursor.sequence), value: active.cursor.value },
        }
      })

      const checkpoint = Effect.fn("Controller.checkpoint")(function* (
        executorAccess: ProtocolAccess,
        staged: FilesystemCheckpoint,
      ) {
        const access = yield* assignmentAccess(executorAccess)
        const assignment = yield* assignments.authenticate(access).pipe(Effect.mapError(assignmentFailure))
        const expectedPrefix = `assignments/${assignment.id}/g${assignment.generation}/`
        if (!staged.objectKey.startsWith(expectedPrefix))
          return yield* failure("checkpoint", "Checkpoint object is outside the assignment prefix")
        if (
          staged.cursor.sequence !== number(assignment.cursor.sequence) ||
          staged.cursor.value !== assignment.cursor.value
        )
          return yield* failure("checkpoint", "Checkpoint cursor is not the acknowledged executor cursor")
        const inspected = yield* checkpointInspector
          .inspect(staged.objectKey)
          .pipe(Effect.mapError((cause) => failure("checkpoint", cause.message)))
        if (inspected.contentDigest !== staged.contentDigest || inspected.sizeBytes !== staged.sizeBytes)
          return yield* failure("checkpoint", "Checkpoint object digest or byte length did not verify")
        const manifest = yield* assignments
          .commitCheckpoint({
            access,
            id: CheckpointId.make(staged.checkpointId),
            objectKey: staged.objectKey,
            contentDigest: staged.contentDigest,
            sizeBytes: staged.sizeBytes,
            format: staged.format,
            cursor: { sequence: Sequence.make(String(staged.cursor.sequence)), value: staged.cursor.value },
            metadata: {},
          })
          .pipe(Effect.mapError(assignmentFailure))
        return {
          assignmentId: manifest.assignmentId,
          generation: number(manifest.assignmentGeneration),
          sandboxId: executorAccess.fence.instanceId,
          checkpoint: staged,
          verifiedAt: epochMillis(manifest.verifiedAt),
        }
      })

      const checkout = Effect.fn("Controller.checkout")(function* (input: ProtocolAccess) {
        const assignment = yield* assignments
          .authenticate(yield* assignmentAccess(input))
          .pipe(Effect.mapError(assignmentFailure))
        if (assignment.checkout === null)
          return yield* failure("checkout", "Repository checkout is unavailable for this assignment")
        return yield* checkoutBroker
          .issue(assignment.checkout)
          .pipe(Effect.mapError((cause) => failure("checkout", cause.message)))
      })

      const cleanupOrphans = Effect.gen(function* () {
        const durable = yield* assignments.listManaged.pipe(Effect.mapError(assignmentFailure))
        const active = new Set(
          durable.flatMap((assignment) => {
            const id = providerInstanceId(assignment)
            return assignment.lifecycle._tag === "Terminated" || id === undefined ? [] : [id]
          }),
        )
        const inventory = yield* provider.inventory.pipe(Effect.mapError(providerFailure))
        const orphans = inventory
          .filter(
            (sandbox) =>
              sandbox.metadata["rika.app-id"] === options.appId &&
              sandbox.metadata["rika.deployment-id"] === options.deploymentId &&
              !active.has(sandbox.sandboxId),
          )
          .map((sandbox) => sandbox.sandboxId)
        yield* Effect.forEach(orphans, (sandboxId) => provider.kill(sandboxId).pipe(Effect.mapError(providerFailure)), {
          discard: true,
        })
        return orphans
      })

      return Controller.of({
        provision,
        replace,
        resume,
        pause,
        kill,
        hello,
        reconnect,
        validateAccess,
        heartbeat,
        checkpoint,
        checkout,
        cleanupOrphans,
      })
    }),
  )
