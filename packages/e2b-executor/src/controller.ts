import { type ExecutorAssignment, type E2BPlacement } from "@rika/product/executor-assignment"
import { AssignmentError, ExecutorAssignments, type Access } from "@rika/product/executor-assignments"
import { resolveEgressPolicy, type EnvironmentPhase, type PhaseEgressPolicy } from "@rika/product/environment-policy"
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
  type CheckpointProposal,
  type CheckpointRestore,
  type Cursor,
  type EncodedArchive,
  type Fence,
  type FilesystemCheckpoint,
  type Heartbeat,
  type Hello,
  type QuiescedOperation,
  type WorkspaceProof,
} from "@rika/remote-execution/protocol"
import { encodeArchive, type SetupCacheKey } from "@rika/remote-execution/workspace-archive"
import { Context, Crypto, DateTime, Effect, Encoding, Layer, Option, Redacted, Schema } from "effect"
import { StoredArchive, Vault } from "./checkpoint"
import { Credentials, type Credential, type CredentialPurpose } from "./checkout"
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

export interface Quiescence {
  readonly access: ProtocolAccess
  readonly operations: ReadonlyArray<QuiescedOperation>
  readonly checkpoint: CheckpointProposal
}

export interface WorkspaceAuthorization {
  readonly egress: PhaseEgressPolicy
  readonly environmentDigest: string
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
  readonly controlEgress: ReadonlyArray<string>
  readonly idleTimeoutMillis?: number
  readonly heartbeatIntervalMillis?: number
  readonly leaseLifetimeMillis?: number
  readonly bootstrapLifetimeMillis?: number
  readonly setupCache?: boolean
}

export interface Interface {
  readonly provision: (
    assignmentId: string,
    authorization: WorkspaceAuthorization,
  ) => Effect.Effect<Assignment, ControllerError>
  readonly replace: (
    key: AssignmentKey,
    authorization: WorkspaceAuthorization,
  ) => Effect.Effect<Assignment, ControllerError>
  readonly resume: (
    key: AssignmentKey,
    authorization: WorkspaceAuthorization,
  ) => Effect.Effect<Assignment, ControllerError>
  readonly pause: (key: AssignmentKey, quiescence?: Quiescence) => Effect.Effect<Assignment, ControllerError>
  readonly kill: (key: AssignmentKey) => Effect.Effect<Assignment, ControllerError>
  readonly hello: (hello: Hello) => Effect.Effect<Welcome, ControllerError>
  readonly reconnect: (access: ProtocolAccess) => Effect.Effect<ReconnectWelcome, ControllerError>
  readonly validateAccess: (access: ProtocolAccess) => Effect.Effect<void, ControllerError>
  readonly heartbeat: (heartbeat: Heartbeat) => Effect.Effect<Receipt, ControllerError>
  readonly checkpoint: (
    access: ProtocolAccess,
    checkpoint: CheckpointProposal,
  ) => Effect.Effect<VerifiedCheckpoint, ControllerError>
  readonly credential: (
    access: ProtocolAccess,
    request: {
      readonly ownerId: string
      readonly assignmentId: string
      readonly repositoryId: string
      readonly workspaceId: string
      readonly purpose: CredentialPurpose
      readonly assignmentGeneration: number
      readonly leaseEpoch: number
    },
  ) => Effect.Effect<Credential, ControllerError>
  readonly revokeCredential: (
    access: ProtocolAccess,
    request: {
      readonly ownerId: string
      readonly assignmentId: string
      readonly repositoryId: string
      readonly workspaceId: string
      readonly purpose: CredentialPurpose
      readonly assignmentGeneration: number
      readonly leaseEpoch: number
    },
  ) => Effect.Effect<void, ControllerError>
  readonly workspace: (access: ProtocolAccess) => Effect.Effect<ExecutorAssignment, ControllerError>
  readonly ready: (
    access: ProtocolAccess,
    proof: WorkspaceProof,
    environmentDigest: string,
  ) => Effect.Effect<void, ControllerError>
  readonly loadSetupCache: (
    access: ProtocolAccess,
    key: SetupCacheKey,
    environmentDigest: string,
  ) => Effect.Effect<ReturnType<typeof encodeArchive> | null, ControllerError>
  readonly storeSetupCache: (
    access: ProtocolAccess,
    key: SetupCacheKey,
    archive: EncodedArchive,
    environmentDigest: string,
  ) => Effect.Effect<void, ControllerError>
  readonly activatePhase: (access: ProtocolAccess, egress: PhaseEgressPolicy) => Effect.Effect<void, ControllerError>
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
): Layer.Layer<Controller, ControllerError, Vault | Credentials | Crypto.Crypto | Provider | ExecutorAssignments> =>
  Layer.effect(
    Controller,
    Effect.gen(function* () {
      if (options.templateId.length === 0) return yield* failure("protocol", "Template ID is required")
      if (options.templateBuildId.length === 0) return yield* failure("protocol", "Template build ID is required")
      if (options.controlEgress.length === 0) return yield* failure("protocol", "Executor control egress is required")
      const assignments = yield* ExecutorAssignments
      const provider = yield* Provider
      const crypto = yield* Crypto.Crypto
      const vault = yield* Vault
      const checkoutBroker = yield* Credentials
      const idleTimeoutMillis = options.idleTimeoutMillis ?? IdleTimeoutMillis
      const heartbeatIntervalMillis = options.heartbeatIntervalMillis ?? DefaultHeartbeatIntervalMillis
      const leaseLifetimeMillis = options.leaseLifetimeMillis ?? DefaultLeaseLifetimeMillis
      const bootstrapLifetimeMillis = options.bootstrapLifetimeMillis ?? DefaultBootstrapLifetimeMillis

      const allowedEgress = (policy: PhaseEgressPolicy, requiredPhase?: EnvironmentPhase) => {
        if (requiredPhase !== undefined && policy.phase !== requiredPhase)
          return Effect.fail(failure("protocol", `${requiredPhase} egress policy is required`))
        const resolved = resolveEgressPolicy({
          phase: policy.phase,
          approved: [...options.controlEgress, ...policy.allow],
        })
        return resolved === undefined
          ? Effect.fail(failure("protocol", "Egress allowlist must be constrained"))
          : Effect.succeed(resolved.allow)
      }

      const authorizeWorkspace = Effect.fn("Controller.authorizeWorkspace")(function* (
        authorization: WorkspaceAuthorization,
        requiredPhase: EnvironmentPhase,
      ) {
        if (!/^sha256:[a-f0-9]{64}$/.test(authorization.environmentDigest))
          return yield* failure("protocol", "Workspace environment digest is invalid")
        return yield* allowedEgress(authorization.egress, requiredPhase)
      })

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

      const approvedPlacement = Effect.fn("Controller.approvedPlacement")(function* (assignment: ExecutorAssignment) {
        const placement = yield* e2bPlacement(assignment)
        if (placement.templateBuildId !== options.templateBuildId)
          return yield* failure("provider", "Assignment template build is not approved")
        return placement
      })

      const createRequest = Effect.fn("Controller.createRequest")(function* (
        assignment: ExecutorAssignment,
        authorization: WorkspaceAuthorization,
      ) {
        const placement = yield* approvedPlacement(assignment)
        const request: CreateRequest = {
          appId: options.appId,
          deploymentId: options.deploymentId,
          templateId: options.templateId,
          templateBuildId: placement.templateBuildId,
          assignmentId: assignment.id,
          threadId: assignment.threadId,
          generation: number(assignment.generation),
          idleTimeoutMillis,
          allowedEgress: yield* allowedEgress(authorization.egress),
          environment: {
            RIKA_EXECUTOR_TARGET: "e2b",
            RIKA_EXECUTOR_ASSIGNMENT_ID: assignment.id,
            RIKA_EXECUTOR_GENERATION: assignment.generation,
            RIKA_EXECUTOR_ID: `${assignment.id}:g${assignment.generation}`,
            RIKA_EXECUTOR_TEMPLATE_BUILD_ID: placement.templateBuildId,
            RIKA_EXECUTOR_API_URL: options.apiUrl,
            RIKA_EXECUTOR_WORKSPACE_ID: assignment.workspaceId,
            RIKA_EXECUTOR_OWNER_ID: assignment.ownerId,
            RIKA_EXECUTOR_THREAD_ID: assignment.threadId,
            RIKA_EXECUTOR_ENVIRONMENT_DIGEST: authorization.environmentDigest,
            RIKA_EXECUTOR_SETUP_CACHE: options.setupCache === true ? "1" : "0",
            ...(assignment.checkout === null
              ? {}
              : {
                  RIKA_EXECUTOR_REPOSITORY_ID: assignment.checkout.repositoryId,
                  RIKA_EXECUTOR_REPOSITORY_OWNER: assignment.checkout.owner,
                  RIKA_EXECUTOR_REPOSITORY_NAME: assignment.checkout.name,
                  RIKA_EXECUTOR_COMMIT_SHA: assignment.checkout.commitSha,
                }),
            RIKA_CHECKPOINT_OBJECT_PREFIX: `assignments/${assignment.id}/g${assignment.generation}/`,
          },
        }
        return request
      })

      const bootstrapIdentity = Effect.fn("Controller.bootstrapIdentity")(function* (
        assignment: ExecutorAssignment,
        instanceId: string,
        lifecycle: "fresh" | "resume" | "replacement",
        environmentDigest: string,
      ) {
        const placement = yield* approvedPlacement(assignment)
        return {
          target: "e2b" as const,
          ownerId: assignment.ownerId,
          threadId: assignment.threadId,
          assignmentId: assignment.id,
          assignmentGeneration: number(assignment.generation),
          instanceId,
          executorId: `${assignment.id}:g${assignment.generation}`,
          templateBuildId: placement.templateBuildId,
          apiUrl: options.apiUrl,
          workspaceId: assignment.workspaceId,
          repository:
            assignment.checkout === null
              ? null
              : {
                  repositoryId: assignment.checkout.repositoryId,
                  owner: assignment.checkout.owner,
                  name: assignment.checkout.name,
                  commitSha: assignment.checkout.commitSha,
                },
          lifecycle,
          environmentDigest,
          setupCache: options.setupCache === true,
        }
      })

      const checkpointScope = (input: {
        readonly ownerId: string
        readonly threadId: string
        readonly assignmentId: string
        readonly generation: number
        readonly checkpointId: string
      }) => input

      const restoreCheckpoint = Effect.fn("Controller.restoreCheckpoint")(function* (assignment: ExecutorAssignment) {
        const manifest = yield* assignments.latestCheckpoint(assignment.id).pipe(Effect.mapError(assignmentFailure))
        if (manifest === undefined) return null
        const stored = yield* Schema.decodeUnknownEffect(StoredArchive)({
          objectKey: manifest.objectKey,
          contentDigest: manifest.contentDigest,
          sizeBytes: manifest.sizeBytes,
          ...manifest.metadata,
        }).pipe(Effect.mapError(() => failure("checkpoint", "Checkpoint manifest metadata is invalid")))
        const archive = yield* vault
          .loadCheckpoint(
            checkpointScope({
              ownerId: manifest.ownerId,
              threadId: manifest.threadId,
              assignmentId: manifest.assignmentId,
              generation: number(manifest.assignmentGeneration),
              checkpointId: manifest.id,
            }),
            stored,
          )
          .pipe(Effect.mapError((error) => failure("checkpoint", error.message)))
        return { checkpointId: manifest.id, archive: encodeArchive(archive) } satisfies CheckpointRestore
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
        authorization: WorkspaceAuthorization,
        lifecycle: "fresh" | "resume" | "replacement",
        restore: CheckpointRestore | null,
      ) {
        if (provisioning.lifecycle._tag !== "Provisioning")
          return yield* failure("assignment-conflict", "Assignment is not provisioning")
        const existingProviderId = provisioning.lifecycle.providerInstanceId
        const sandbox =
          existingProviderId === null
            ? yield* provider
                .create(yield* createRequest(provisioning, authorization))
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
        yield* provider
          .bootstrap({
            sandboxId: sandbox.sandboxId,
            credential,
            identity: yield* bootstrapIdentity(
              provisioning,
              sandbox.sandboxId,
              lifecycle,
              authorization.environmentDigest,
            ),
            restore,
          })
          .pipe(Effect.mapError(providerFailure))
        return publicAssignment(bound)
      })

      const beginProvisioning = Effect.fn("Controller.beginProvisioning")(function* (
        assignment: ExecutorAssignment,
        authorization: WorkspaceAuthorization,
      ) {
        const latest = yield* assignments.latestCheckpoint(assignment.id).pipe(Effect.mapError(assignmentFailure))
        const replacement = latest !== undefined && latest.assignmentGeneration !== assignment.generation
        const resume =
          latest !== undefined &&
          latest.assignmentGeneration === assignment.generation &&
          providerInstanceId(assignment) !== undefined
        yield* authorizeWorkspace(authorization, replacement || resume ? "runtime" : "setup")
        const credential = yield* issueSecret("executor-bootstrap")
        const restore = replacement ? yield* restoreCheckpoint(assignment) : null
        const provisioning = yield* assignments
          .beginProvisioning({
            ...version(assignment),
            bootstrapCredentialDigest: yield* digest(credential),
            bootstrapLifetimeMillis,
          })
          .pipe(Effect.mapError(assignmentFailure))
        let lifecycle: "fresh" | "replacement" | "resume" = "fresh"
        if (replacement) lifecycle = "replacement"
        else if (resume) lifecycle = "resume"
        return yield* createAndBootstrap(provisioning, credential, authorization, lifecycle, restore)
      })

      const resumeAssignment = Effect.fn("Controller.resumeAssignment")(function* (
        assignment: ExecutorAssignment,
        authorization: WorkspaceAuthorization,
      ) {
        yield* authorizeWorkspace(authorization, "runtime")
        const credential = yield* issueSecret("executor-bootstrap")
        const provisioning = yield* assignments
          .resume({
            ...version(assignment),
            bootstrapCredentialDigest: yield* digest(credential),
            bootstrapLifetimeMillis,
          })
          .pipe(Effect.mapError(assignmentFailure))
        return yield* createAndBootstrap(provisioning, credential, authorization, "resume", null)
      })

      const provision = Effect.fn("Controller.provision")(function* (
        assignmentId: string,
        authorization: WorkspaceAuthorization,
      ) {
        const assignment = yield* load(assignmentId)
        yield* approvedPlacement(assignment)
        if (assignment.lifecycle._tag === "Active") {
          yield* provider
            .connect(assignment.lifecycle.providerInstanceId, idleTimeoutMillis)
            .pipe(Effect.mapError(providerFailure))
          return publicAssignment(assignment)
        }
        if (assignment.lifecycle._tag === "Paused") return yield* resumeAssignment(assignment, authorization)
        if (assignment.lifecycle._tag === "Terminated")
          return yield* failure("fenced", `Assignment ${assignmentId} is terminated`)
        return yield* beginProvisioning(assignment, authorization)
      })

      const replace = Effect.fn("Controller.replace")(function* (
        key: AssignmentKey,
        authorization: WorkspaceAuthorization,
      ) {
        yield* authorizeWorkspace(authorization, "runtime")
        const previous = yield* current(key)
        yield* approvedPlacement(previous)
        if (previous.lifecycle._tag !== "Active")
          return yield* failure("assignment-conflict", "Only an active assignment can be replaced")
        const retiringProviderId = providerInstanceId(previous)
        const restore = yield* restoreCheckpoint(previous)
        const identity = yield* issueSecret("executor-bootstrap")
        const replacing = yield* assignments
          .beginReplacement({
            ...version(previous),
            bootstrapCredentialDigest: yield* digest(identity),
            bootstrapLifetimeMillis,
          })
          .pipe(Effect.mapError(assignmentFailure))
        const replacement = yield* createAndBootstrap(replacing, identity, authorization, "replacement", restore)
        if (retiringProviderId !== undefined) yield* provider.kill(retiringProviderId).pipe(Effect.ignore)
        return replacement
      })

      const resume = Effect.fn("Controller.resume")(function* (
        key: AssignmentKey,
        authorization: WorkspaceAuthorization,
      ) {
        const assignment = yield* current(key)
        yield* approvedPlacement(assignment)
        if (assignment.lifecycle._tag === "Active") return publicAssignment(assignment)
        if (assignment.lifecycle._tag !== "Paused")
          return yield* failure("assignment-conflict", "Assignment is not paused")
        return yield* resumeAssignment(assignment, authorization)
      })

      const pause = Effect.fn("Controller.pause")(function* (key: AssignmentKey, quiescence?: Quiescence) {
        const assignment = yield* current(key)
        if (assignment.lifecycle._tag === "Paused") {
          yield* provider
            .pauseFilesystem(assignment.lifecycle.providerInstanceId)
            .pipe(Effect.mapError(providerFailure))
          return publicAssignment(assignment)
        }
        if (assignment.lifecycle._tag !== "Active")
          return yield* failure("assignment-conflict", "Only an active assignment can pause")
        if (quiescence === undefined)
          return yield* failure("assignment-conflict", "An active assignment must quiesce before it can pause")
        if (
          quiescence.access.fence.assignmentId !== assignment.id ||
          quiescence.access.fence.assignmentGeneration !== number(assignment.generation)
        )
          return yield* failure("fenced", "Quiescence belongs to a stale assignment")
        const operationKeys = new Set(quiescence.operations.map((operation) => operation.operationKey))
        if (operationKeys.size !== quiescence.operations.length)
          return yield* failure("protocol", "Quiescence contains duplicate operation outcomes")
        yield* checkpoint(quiescence.access, quiescence.checkpoint)
        const checkpointed = yield* load(assignment.id)
        if (checkpointed.lifecycle._tag !== "Active")
          return yield* failure("assignment-conflict", "Assignment changed while its checkpoint was committed")
        const paused = yield* assignments.pause(version(checkpointed)).pipe(Effect.mapError(assignmentFailure))
        yield* provider
          .pauseFilesystem(checkpointed.lifecycle.providerInstanceId)
          .pipe(Effect.mapError(providerFailure))
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
        yield* approvedPlacement(
          yield* current({
            assignmentId: input.fence.assignmentId,
            generation: input.fence.assignmentGeneration,
          }),
        )
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
        if (!input.capabilities.cells)
          return yield* failure("protocol", "Executor transport does not support cell execution")
        const assignment = yield* current({
          assignmentId: input.fence.assignmentId,
          generation: input.fence.assignmentGeneration,
        })
        const placement = yield* approvedPlacement(assignment)
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
              capabilities: input.workspaceCapabilities,
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
        proposal: CheckpointProposal,
      ) {
        const access = yield* assignmentAccess(executorAccess)
        const assignment = yield* assignments.authenticate(access).pipe(Effect.mapError(assignmentFailure))
        if (
          proposal.cursor.sequence !== number(assignment.cursor.sequence) ||
          proposal.cursor.value !== assignment.cursor.value
        )
          return yield* failure("checkpoint", "Checkpoint cursor is not the acknowledged executor cursor")
        const known = yield* assignments.latestCheckpoint(assignment.id).pipe(Effect.mapError(assignmentFailure))
        if (known?.id === proposal.checkpointId) {
          const stored = yield* Schema.decodeUnknownEffect(StoredArchive)({
            objectKey: known.objectKey,
            contentDigest: known.contentDigest,
            sizeBytes: known.sizeBytes,
            ...known.metadata,
          }).pipe(Effect.mapError(() => failure("checkpoint", "Checkpoint manifest metadata is invalid")))
          if (
            known.assignmentGeneration !== assignment.generation ||
            known.cursor.sequence !== assignment.cursor.sequence ||
            known.cursor.value !== assignment.cursor.value ||
            stored.archiveDigest !== proposal.archive.contentDigest ||
            stored.archiveSizeBytes !== proposal.archive.sizeBytes
          )
            return yield* failure("checkpoint", "Checkpoint identity has different content")
          return {
            assignmentId: known.assignmentId,
            generation: number(known.assignmentGeneration),
            sandboxId: executorAccess.fence.instanceId,
            checkpoint: {
              version: 1 as const,
              checkpointId: known.id,
              objectKey: known.objectKey,
              contentDigest: known.contentDigest,
              sizeBytes: known.sizeBytes,
              format: "tar.zst" as const,
              cursor: proposal.cursor,
            },
            verifiedAt: epochMillis(known.verifiedAt),
          }
        }
        const stored = yield* vault
          .storeCheckpoint(
            checkpointScope({
              ownerId: assignment.ownerId,
              threadId: assignment.threadId,
              assignmentId: assignment.id,
              generation: number(assignment.generation),
              checkpointId: proposal.checkpointId,
            }),
            proposal.archive,
          )
          .pipe(Effect.mapError((error) => failure("checkpoint", error.message)))
        const staged: FilesystemCheckpoint = {
          version: 1,
          checkpointId: proposal.checkpointId,
          objectKey: stored.objectKey,
          contentDigest: stored.contentDigest,
          sizeBytes: stored.sizeBytes,
          format: "tar.zst",
          cursor: proposal.cursor,
        }
        const manifest = yield* assignments
          .commitCheckpoint({
            access,
            id: CheckpointId.make(staged.checkpointId),
            objectKey: staged.objectKey,
            contentDigest: staged.contentDigest,
            sizeBytes: staged.sizeBytes,
            format: staged.format,
            cursor: { sequence: Sequence.make(String(staged.cursor.sequence)), value: staged.cursor.value },
            metadata: {
              archiveDigest: stored.archiveDigest,
              archiveSizeBytes: stored.archiveSizeBytes,
              encryption: stored.encryption,
            },
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

      const ready = Effect.fn("Controller.ready")(function* (
        input: ProtocolAccess,
        proof: WorkspaceProof,
        environmentDigest: string,
      ) {
        const assignment = yield* assignments
          .authenticate(yield* assignmentAccess(input))
          .pipe(Effect.mapError(assignmentFailure))
        const placement = yield* approvedPlacement(assignment)
        if (
          proof.workspaceId !== assignment.workspaceId ||
          proof.templateBuildId !== placement.templateBuildId ||
          proof.environmentDigest !== environmentDigest
        )
          return yield* failure("fenced", "Workspace proof does not match its assignment")
        if (assignment.checkout === null) {
          if (proof.repositoryId !== null || proof.baseCommit !== null || proof.headCommit !== null)
            return yield* failure("repository", "Workspace proof has an unexpected repository")
        } else if (
          proof.repositoryId !== assignment.checkout.repositoryId ||
          proof.baseCommit?.toLowerCase() !== assignment.checkout.commitSha.toLowerCase() ||
          proof.headCommit === null
        )
          return yield* failure("repository", "Workspace repository proof does not match its assignment")
        const latest = yield* assignments.latestCheckpoint(assignment.id).pipe(Effect.mapError(assignmentFailure))
        if (
          latest !== undefined &&
          number(latest.assignmentGeneration) < number(assignment.generation) &&
          proof.restoredCheckpointId !== latest.id
        )
          return yield* failure("checkpoint", "Replacement did not restore the latest verified checkpoint")
      })

      const validateCacheKey = Effect.fn("Controller.validateCacheKey")(function* (
        assignment: ExecutorAssignment,
        key: SetupCacheKey,
        environmentDigest: string,
      ) {
        const placement = yield* approvedPlacement(assignment)
        if (
          assignment.checkout === null ||
          key.ownerId !== assignment.ownerId ||
          key.repository.repositoryId !== assignment.checkout.repositoryId ||
          key.repository.owner !== assignment.checkout.owner ||
          key.repository.name !== assignment.checkout.name ||
          key.repository.commitSha.toLowerCase() !== assignment.checkout.commitSha.toLowerCase() ||
          key.templateBuildId !== placement.templateBuildId ||
          key.environmentDigest !== environmentDigest
        )
          return yield* failure("fenced", "Setup cache key does not match its assignment")
      })

      const loadSetupCache = Effect.fn("Controller.loadSetupCache")(function* (
        input: ProtocolAccess,
        key: SetupCacheKey,
        environmentDigest: string,
      ) {
        const assignment = yield* assignments
          .authenticate(yield* assignmentAccess(input))
          .pipe(Effect.mapError(assignmentFailure))
        yield* validateCacheKey(assignment, key, environmentDigest)
        const archive = yield* vault
          .loadSetupCache(key)
          .pipe(Effect.mapError((error) => failure("checkpoint", error.message)))
        return Option.isNone(archive) ? null : encodeArchive(archive.value)
      })

      const storeSetupCache = Effect.fn("Controller.storeSetupCache")(function* (
        input: ProtocolAccess,
        key: SetupCacheKey,
        encoded: EncodedArchive,
        environmentDigest: string,
      ) {
        const assignment = yield* assignments
          .authenticate(yield* assignmentAccess(input))
          .pipe(Effect.mapError(assignmentFailure))
        yield* validateCacheKey(assignment, key, environmentDigest)
        yield* vault
          .storeSetupCache(key, encoded)
          .pipe(Effect.mapError((error) => failure("checkpoint", error.message)))
      })

      const workspace = Effect.fn("Controller.workspace")(function* (input: ProtocolAccess) {
        return yield* assignments.authenticate(yield* assignmentAccess(input)).pipe(Effect.mapError(assignmentFailure))
      })

      const credential = Effect.fn("Controller.credential")(function* (
        input: ProtocolAccess,
        request: {
          readonly ownerId: string
          readonly assignmentId: string
          readonly repositoryId: string
          readonly workspaceId: string
          readonly purpose: CredentialPurpose
          readonly assignmentGeneration: number
          readonly leaseEpoch: number
        },
      ) {
        const access = yield* assignmentAccess(input)
        const assignment = yield* assignments.authenticate(access).pipe(Effect.mapError(assignmentFailure))
        if (
          assignment.checkout === null ||
          request.ownerId !== assignment.ownerId ||
          request.assignmentId !== assignment.id ||
          request.repositoryId !== assignment.checkout.repositoryId ||
          request.workspaceId !== assignment.workspaceId ||
          request.assignmentGeneration !== Number(assignment.generation) ||
          request.leaseEpoch !== Number(access.leaseEpoch)
        )
          return yield* failure("checkout", "Credential request does not match the assigned repository fence")
        return yield* checkoutBroker
          .issue({
            access,
            checkout: assignment.checkout,
            ownerId: request.ownerId,
            workspaceId: request.workspaceId,
            repositoryId: request.repositoryId,
            purpose: request.purpose,
          })
          .pipe(Effect.mapError((cause) => failure("checkout", cause.message)))
      })

      const revokeCredential = Effect.fn("Controller.revokeCredential")(function* (
        input: ProtocolAccess,
        request: {
          readonly ownerId: string
          readonly assignmentId: string
          readonly repositoryId: string
          readonly workspaceId: string
          readonly purpose: CredentialPurpose
          readonly assignmentGeneration: number
          readonly leaseEpoch: number
        },
      ) {
        const access = yield* assignmentAccess(input)
        const assignment = yield* assignments.authenticate(access).pipe(Effect.mapError(assignmentFailure))
        if (
          assignment.checkout === null ||
          request.ownerId !== assignment.ownerId ||
          request.assignmentId !== assignment.id ||
          request.repositoryId !== assignment.checkout.repositoryId ||
          request.workspaceId !== assignment.workspaceId ||
          request.assignmentGeneration !== Number(assignment.generation) ||
          request.leaseEpoch !== Number(access.leaseEpoch)
        )
          return yield* failure("checkout", "Credential revocation does not match the assigned repository fence")
        yield* checkoutBroker
          .revoke(access, request.purpose)
          .pipe(Effect.mapError((cause) => failure("checkout", cause.message)))
      })

      const activatePhase = Effect.fn("Controller.activatePhase")(function* (
        input: ProtocolAccess,
        egress: PhaseEgressPolicy,
      ) {
        const assignment = yield* assignments
          .authenticate(yield* assignmentAccess(input))
          .pipe(Effect.mapError(assignmentFailure))
        if (assignment.lifecycle._tag !== "Active") return yield* failure("fenced", "Executor session is not active")
        yield* provider
          .updateNetwork(assignment.lifecycle.providerInstanceId, yield* allowedEgress(egress))
          .pipe(Effect.mapError(providerFailure))
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
        const preserved = (sandbox: (typeof inventory)[number]) =>
          active.has(sandbox.sandboxId) ||
          durable.some(
            (assignment) =>
              assignment.lifecycle._tag !== "Terminated" &&
              (assignment.lifecycle._tag === "Provisioning" || assignment.lifecycle._tag === "AwaitingBootstrap") &&
              matchesGeneration(assignment, sandbox.templateId, sandbox.templateBuildId, sandbox.metadata),
          )
        const orphans = inventory
          .filter(
            (sandbox) =>
              sandbox.metadata["rika.app-id"] === options.appId &&
              sandbox.metadata["rika.deployment-id"] === options.deploymentId &&
              !preserved(sandbox),
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
        credential,
        revokeCredential,
        workspace,
        ready,
        loadSetupCache,
        storeSetupCache,
        activatePhase,
        cleanupOrphans,
      })
    }),
  )
