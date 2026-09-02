import type { ExecutorAssignment } from "@rika/product/executor-assignment"
import type { AssignmentsService } from "@rika/product/executor-assignments"
import { resolveEgressPolicy, type EnvironmentPhase, type PhaseEgressPolicy } from "@rika/product/environment-policy"
import * as HostedObservability from "@rika/product/hosted-observability"
import { ExecutorAssignmentId } from "@rika/product/hosted-model"
import { Encoding, Effect, Option, Redacted, Result, Schema, type Crypto } from "effect"
import { StoredArchive, type VaultInterface } from "./checkpoint"
import { ControllerError, type AssignmentKey, type Options, type WorkspaceAuthorization } from "./controller-contract"
import {
  assignmentCorrelation,
  assignmentFailure,
  failures,
  number,
  orbPlacement,
  providerFailure,
  providerInstanceId,
  publicAssignment,
  version,
  type ExecutorEnvironment,
} from "./controller-model"
import type { CreateRequest, Handle, Interface as ProviderInterface, ProviderError } from "./provider"
import { encodeArchive } from "@rika/remote-execution/workspace-archive"
import type { CheckpointRestore, WorkspaceSeedRestore } from "@rika/remote-execution/protocol"

const failure = failures.make

interface ProvisioningContext {
  readonly options: Options
  readonly assignments: AssignmentsService
  readonly provider: ProviderInterface
  readonly crypto: Crypto.Crypto
  readonly vault: VaultInterface
  readonly idleTimeoutMillis: number
  readonly bootstrapLifetimeMillis: number
}

export const provisioningOperations = ({
  options,
  assignments,
  provider,
  crypto,
  vault,
  idleTimeoutMillis,
  bootstrapLifetimeMillis,
}: ProvisioningContext) => {
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
    const placement = yield* orbPlacement(assignment)
    if (placement.templateBuildId !== options.templateBuildId)
      return yield* failure("provider", "Assignment template build is not approved")
    return placement
  })

  const createRequest = Effect.fn("Controller.createRequest")(function* (
    assignment: ExecutorAssignment,
    authorization: WorkspaceAuthorization,
  ) {
    const placement = yield* approvedPlacement(assignment)
    const environment: ExecutorEnvironment = {
      RIKA_EXECUTOR_TARGET: "orb",
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
      RIKA_CHECKPOINT_OBJECT_PREFIX: `assignments/${assignment.id}/g${assignment.generation}/`,
    }
    if (assignment.checkout !== null) {
      environment.RIKA_EXECUTOR_REPOSITORY_ID = assignment.checkout.repositoryId
      environment.RIKA_EXECUTOR_REPOSITORY_OWNER = assignment.checkout.owner
      environment.RIKA_EXECUTOR_REPOSITORY_NAME = assignment.checkout.name
      environment.RIKA_EXECUTOR_COMMIT_SHA = assignment.checkout.commitSha
    }
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
      environment,
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
      target: "orb" as const,
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

  const restoreWorkspaceSeed = Effect.fn("Controller.restoreWorkspaceSeed")(function* (assignment: ExecutorAssignment) {
    if (assignment.workspaceSeed === null) return null
    const stored = yield* Schema.decodeEffect(StoredArchive)(assignment.workspaceSeed).pipe(
      Effect.mapError(() => failure("checkpoint", "Workspace seed manifest is invalid")),
    )
    const archive = yield* vault
      .loadWorkspaceSeed(assignment.workspaceSeed.id, stored)
      .pipe(Effect.mapError((error) => failure("checkpoint", error.message)))
    return {
      seedId: assignment.workspaceSeed.id,
      archive: encodeArchive(archive),
    } satisfies WorkspaceSeedRestore
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
    assignment.placement._tag === "OrbPlacement" &&
    templateId === options.templateId &&
    templateBuildId === assignment.placement.templateBuildId

  const findCreatedSandbox = Effect.fn("Controller.findCreatedSandbox")(function* (assignment: ExecutorAssignment) {
    const inventory = yield* provider.inventory.pipe(Effect.mapError(providerFailure))
    const matches = inventory.filter((entry) =>
      matchesGeneration(assignment, entry.templateId, entry.templateBuildId, entry.metadata),
    )
    if (matches.length === 0) return Option.none()
    const candidates = matches.toSorted((left, right) => left.sandboxId.localeCompare(right.sandboxId))
    let adopted: Handle | undefined
    let connectError: ControllerError | undefined
    for (const candidate of candidates) {
      const connected = yield* Effect.result(
        provider.connect(candidate.sandboxId, idleTimeoutMillis).pipe(Effect.mapError(providerFailure)),
      )
      if (Result.isSuccess(connected)) {
        adopted = connected.success
        break
      }
      connectError = connected.failure
    }
    if (adopted === undefined)
      return yield* connectError ?? failure("provider", "No matching sandbox could be connected")
    return Option.some(adopted)
  })

  const reconcileCreate = Effect.fn("Controller.reconcileCreate")(function* (
    assignment: ExecutorAssignment,
    cause: ProviderError,
  ) {
    const created = yield* findCreatedSandbox(assignment)
    if (Option.isSome(created)) return created.value
    yield* HostedObservability.unknownOutcome(assignmentCorrelation(assignment))
    return yield* failure("provider", `create outcome is unknown and no sandbox exists: ${cause.message}`)
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
    let sandbox: Handle
    if (existingProviderId !== null)
      sandbox = yield* provider.connect(existingProviderId, idleTimeoutMillis).pipe(Effect.mapError(providerFailure))
    else {
      const created = yield* findCreatedSandbox(provisioning)
      sandbox = Option.isSome(created)
        ? created.value
        : yield* provider
            .create(yield* createRequest(provisioning, authorization))
            .pipe(Effect.catch((cause) => reconcileCreate(provisioning, cause)))
    }
    const binding = yield* Effect.result(
      assignments.bindProviderInstance({
        ...version(provisioning),
        providerInstanceId: sandbox.sandboxId,
      }),
    )
    let bound: ExecutorAssignment
    if (Result.isSuccess(binding)) bound = binding.success
    else {
      const latest = yield* Effect.result(assignments.get(provisioning.id))
      if (
        Result.isSuccess(latest) &&
        latest.success !== undefined &&
        providerInstanceId(latest.success) === sandbox.sandboxId &&
        latest.success.lifecycle._tag !== "Provisioning"
      )
        bound = latest.success
      else {
        if (Result.isFailure(latest)) yield* HostedObservability.unknownOutcome(assignmentCorrelation(provisioning))
        else if (existingProviderId === null) yield* provider.kill(sandbox.sandboxId).pipe(Effect.ignore)
        return yield* assignmentFailure(binding.failure)
      }
    }
    if (bound.lifecycle._tag === "AwaitingBootstrap") {
      const seed = lifecycle === "resume" || restore !== null ? null : yield* restoreWorkspaceSeed(provisioning)
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
          seed,
          restore,
        })
        .pipe(Effect.mapError(providerFailure))
    }
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
    return yield* HostedObservability.observe(
      "attach",
      assignmentCorrelation(assignment),
      Effect.gen(function* () {
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
      }),
    ).pipe(
      Effect.tapError((error) =>
        error.kind === "assignment-missing" || error.kind === "assignment-conflict" || error.kind === "fenced"
          ? Effect.void
          : HostedObservability.health("restore_failure", assignmentCorrelation(assignment)),
      ),
    )
  })

  const replaceAssignment = Effect.fn("Controller.replaceAssignment")(function* (
    previous: ExecutorAssignment,
    authorization: WorkspaceAuthorization,
  ) {
    return yield* HostedObservability.observe(
      "attach",
      assignmentCorrelation(previous),
      Effect.gen(function* () {
        const placement = yield* orbPlacement(previous)
        const checkpoint = yield* assignments.latestCheckpoint(previous.id).pipe(Effect.mapError(assignmentFailure))
        // The host reports this lifecycle in ExecutorHello and the gateway grants the phase it implies
        // ("fresh" → setup, otherwise runtime), so the lifecycle must follow the phase bootstrapped here.
        const phase: EnvironmentPhase =
          previous.lifecycle._tag === "Active" || previous.lifecycle._tag === "Paused" || checkpoint !== undefined
            ? "runtime"
            : "setup"
        yield* authorizeWorkspace(authorization, phase)
        const restore = checkpoint === undefined ? null : yield* restoreCheckpoint(previous)
        const identity = yield* issueSecret("executor-bootstrap")
        const replacing = yield* assignments
          .beginReplacement({
            ...version(previous),
            placement: { ...placement, templateBuildId: options.templateBuildId },
            bootstrapCredentialDigest: yield* digest(identity),
            bootstrapLifetimeMillis,
          })
          .pipe(Effect.mapError(assignmentFailure))
        return yield* createAndBootstrap(
          replacing,
          identity,
          authorization,
          phase === "runtime" ? "replacement" : "fresh",
          restore,
        )
      }),
    )
  })

  const provision = Effect.fn("Controller.provision")(function* (
    assignmentId: string,
    authorization: WorkspaceAuthorization,
  ) {
    const assignment = yield* load(assignmentId)
    return yield* Effect.gen(function* () {
      if (assignment.lifecycle._tag === "Terminated")
        return yield* failure("fenced", `Assignment ${assignmentId} is terminated`)
      const placement = yield* orbPlacement(assignment)
      if (placement.templateBuildId !== options.templateBuildId)
        return yield* replaceAssignment(assignment, authorization)
      if (assignment.lifecycle._tag === "Active") {
        const lease = yield* Effect.result(
          assignments.validateFence({
            assignmentId: assignment.id,
            assignmentGeneration: assignment.generation,
            leaseEpoch: assignment.lifecycle.leaseEpoch,
          }),
        )
        if (Result.isFailure(lease)) {
          if (lease.failure.reason !== "stale-fence") return yield* assignmentFailure(lease.failure)
          return yield* replaceAssignment(assignment, authorization)
        }
        yield* provider
          .connect(assignment.lifecycle.providerInstanceId, idleTimeoutMillis)
          .pipe(Effect.mapError(providerFailure))
        return publicAssignment(assignment)
      }
      if (assignment.lifecycle._tag === "Paused") return yield* resumeAssignment(assignment, authorization)
      return yield* beginProvisioning(assignment, authorization)
    }).pipe(
      Effect.tapError((error) =>
        assignment.lifecycle._tag === "Paused" ||
        error.kind === "assignment-missing" ||
        error.kind === "assignment-conflict" ||
        error.kind === "fenced"
          ? Effect.void
          : HostedObservability.health("setup_failure", assignmentCorrelation(assignment)),
      ),
    )
  })

  const replace = Effect.fn("Controller.replace")(function* (
    key: AssignmentKey,
    authorization: WorkspaceAuthorization,
  ) {
    const previous = yield* current(key)
    if (previous.lifecycle._tag !== "Active")
      return yield* failure("assignment-conflict", "Only an active assignment can be replaced")
    return yield* replaceAssignment(previous, authorization)
  })

  const resume = Effect.fn("Controller.resume")(function* (key: AssignmentKey, authorization: WorkspaceAuthorization) {
    const assignment = yield* current(key)
    yield* approvedPlacement(assignment)
    if (assignment.lifecycle._tag === "Active") return publicAssignment(assignment)
    if (assignment.lifecycle._tag !== "Paused") return yield* failure("assignment-conflict", "Assignment is not paused")
    return yield* resumeAssignment(assignment, authorization)
  })

  return {
    allowedEgress,
    digest,
    load,
    current,
    approvedPlacement,
    checkpointScope,
    provision,
    replace,
    resume,
  }
}
