import type { ExecutorAssignment, WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import { ExecutorAssignments } from "@rika/product/executor-assignments"
import type { PhaseEgressPolicy } from "@rika/product/environment-policy"
import * as HostedObservability from "@rika/product/hosted-observability"
import { ExecutorAssignmentId, FencingGeneration } from "@rika/product/hosted-model"
import type { Access as ProtocolAccess, EncodedArchive, WorkspaceProof } from "@rika/remote-execution/protocol"
import { encodeArchive, type SetupCacheKey } from "@rika/remote-execution/workspace-archive"
import { Clock, Context, Crypto, Effect, Layer, Option } from "effect"
import { Vault } from "./checkpoint"
import { Credentials } from "./checkout"
import {
  ControllerError,
  DefaultBootstrapLifetimeMillis,
  DefaultHeartbeatIntervalMillis,
  DefaultLeaseLifetimeMillis,
  DefaultOrphanGraceMillis,
  IdleTimeoutMillis,
  type AssignmentKey,
  type CredentialCommand,
  type Interface,
  type Options,
  type Quiescence,
} from "./controller-contract"
import {
  assignmentCorrelation,
  assignmentFailure,
  failures,
  number,
  providerFailure,
  providerInstanceId,
  publicAssignment,
  version,
} from "./controller-model"
import { provisioningOperations } from "./controller-provisioning"
import { sessionOperations } from "./controller-session"
import { Provider } from "./provider"

export * from "./controller-contract"

const failure = failures.make

export class Controller extends Context.Service<Controller, Interface>()("@rika/e2b-executor/controller") {}

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
      const orphanGraceMillis = options.orphanGraceMillis ?? DefaultOrphanGraceMillis
      const orphanCandidates = new Map<string, number>()

      const { allowedEgress, digest, load, current, approvedPlacement, checkpointScope, provision, replace, resume } =
        provisioningOperations({
          options,
          assignments,
          provider,
          crypto,
          vault,
          idleTimeoutMillis,
          bootstrapLifetimeMillis,
        })
      const { assignmentAccess, hello, reconnect, validateAccess, heartbeat, checkpoint } = sessionOperations({
        assignments,
        provider,
        vault,
        idleTimeoutMillis,
        heartbeatIntervalMillis,
        leaseLifetimeMillis,
        digest,
        current,
        approvedPlacement,
        checkpointScope,
      })

      const pause = Effect.fn("Controller.pause")(function* (key: AssignmentKey, quiescence?: Quiescence) {
        const assignment = yield* current(key)
        return yield* HostedObservability.observe(
          "attach",
          assignmentCorrelation(assignment),
          Effect.gen(function* () {
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
            yield* checkpoint(quiescence.access, quiescence.checkpoint)
            const checkpointed = yield* load(assignment.id)
            if (checkpointed.lifecycle._tag !== "Active")
              return yield* failure("assignment-conflict", "Assignment changed while its checkpoint was committed")
            const paused = yield* assignments.pause(version(checkpointed)).pipe(Effect.mapError(assignmentFailure))
            yield* provider
              .pauseFilesystem(checkpointed.lifecycle.providerInstanceId)
              .pipe(Effect.mapError(providerFailure))
            return publicAssignment(paused)
          }),
        )
      })
      const portal = Effect.fn("Controller.portal")(function* (key: AssignmentKey, port: number) {
        const assignment = yield* current(key)
        yield* approvedPlacement(assignment)
        if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
          return yield* failure("protocol", "Portal port must be between 1 and 65535")
        const sandboxId = providerInstanceId(assignment)
        if (sandboxId === undefined) return yield* failure("assignment-conflict", "Orb is not running")
        const hostname = yield* provider.host(sandboxId, port).pipe(Effect.mapError(providerFailure))
        return `https://${hostname}`
      })

      const kill = Effect.fn("Controller.kill")(function* (key: AssignmentKey) {
        const assignment = yield* current(key)
        return yield* HostedObservability.observe(
          "attach",
          assignmentCorrelation(assignment),
          Effect.gen(function* () {
            const sandboxId = providerInstanceId(assignment)
            if (sandboxId !== undefined) yield* provider.kill(sandboxId).pipe(Effect.mapError(providerFailure))
            return publicAssignment(
              yield* assignments.terminate(version(assignment)).pipe(Effect.mapError(assignmentFailure)),
            )
          }),
        )
      })

      const ready = Effect.fn("Controller.ready")(function* (
        input: ProtocolAccess,
        proof: WorkspaceProof,
        capabilities: WorkspaceCapabilitySnapshot,
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
        yield* assignments
          .updateCapabilities({
            access: yield* assignmentAccess(input),
            capabilities,
          })
          .pipe(Effect.mapError(assignmentFailure))
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
        request: CredentialCommand,
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
        const base = {
          access,
          checkout: assignment.checkout,
          ownerId: request.ownerId,
          workspaceId: request.workspaceId,
          repositoryId: request.repositoryId,
        }
        return yield* checkoutBroker
          .issue(
            request.purpose === "branch-push"
              ? {
                  ...base,
                  purpose: "branch-push",
                  publicationId: request.publicationId,
                  branch: request.branch,
                  ref: request.ref,
                  commitSha: request.commitSha,
                }
              : { ...base, purpose: request.purpose },
          )
          .pipe(Effect.mapError((cause) => failure("checkout", cause.message)))
      })

      const revokeCredential = Effect.fn("Controller.revokeCredential")(function* (
        input: ProtocolAccess,
        request: CredentialCommand,
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
          .revoke(access, request.purpose, request.purpose === "branch-push" ? request.publicationId : undefined)
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

      const cleanupClaim = (sandbox: {
        readonly sandboxId: string
        readonly metadata: Readonly<Record<string, string>>
      }) => {
        const assignmentId = sandbox.metadata["rika.assignment-id"]
        const generation = sandbox.metadata["rika.generation"]
        const parsedGeneration = generation === undefined ? Number.NaN : Number(generation)
        if (
          assignmentId !== undefined &&
          assignmentId.length > 0 &&
          assignmentId.length <= 512 &&
          generation !== undefined &&
          Number.isSafeInteger(parsedGeneration) &&
          parsedGeneration >= 1
        )
          return {
            providerInstanceId: sandbox.sandboxId,
            assignmentId: ExecutorAssignmentId.make(assignmentId),
            generation: FencingGeneration.make(generation),
          }
        return { providerInstanceId: sandbox.sandboxId }
      }

      const cleanupOrphans = Effect.gen(function* () {
        const inventory = yield* provider.inventory.pipe(Effect.mapError(providerFailure))
        const candidates = inventory.filter((sandbox) => sandbox.metadata["rika.app-id"] === options.appId)
        const inspected = (yield* Effect.forEach(candidates, (sandbox) =>
          assignments.inspectOrphan(cleanupClaim(sandbox)).pipe(
            Effect.mapError(assignmentFailure),
            Effect.map((status) => {
              if (status === "candidate") return sandbox
              orphanCandidates.delete(sandbox.sandboxId)
              return null
            }),
          ),
        )).flatMap((sandbox) => (sandbox === null ? [] : [sandbox]))
        const candidateIds = new Set(inspected.map((sandbox) => sandbox.sandboxId))
        for (const sandboxId of orphanCandidates.keys())
          if (!candidateIds.has(sandboxId)) orphanCandidates.delete(sandboxId)
        const now = yield* Clock.currentTimeMillis
        const orphans = inspected.filter((sandbox) => {
          const firstSeenAt = orphanCandidates.get(sandbox.sandboxId) ?? now
          orphanCandidates.set(sandbox.sandboxId, firstSeenAt)
          return now - firstSeenAt >= orphanGraceMillis
        })
        const reaped = yield* Effect.forEach(orphans, (sandbox) =>
          assignments.claimOrphan(cleanupClaim(sandbox)).pipe(
            Effect.mapError(assignmentFailure),
            Effect.flatMap((claim) => {
              if (claim === "preserved") {
                orphanCandidates.delete(sandbox.sandboxId)
                return Effect.succeed(null)
              }
              return HostedObservability.health("orphan_sandbox", { sandboxId: sandbox.sandboxId }).pipe(
                Effect.andThen(
                  HostedObservability.observe(
                    "attach",
                    { sandboxId: sandbox.sandboxId },
                    provider.kill(sandbox.sandboxId).pipe(Effect.mapError(providerFailure)),
                  ),
                ),
                Effect.as(sandbox.sandboxId),
                Effect.tap((id) => Effect.sync(() => orphanCandidates.delete(id))),
                Effect.orElseSucceed(() => null),
              )
            }),
          ),
        )
        return reaped.flatMap((sandboxId) => (sandboxId === null ? [] : [sandboxId]))
      })

      return Controller.of({
        provision,
        replace,
        resume,
        pause,
        kill,
        portal,
        hello,
        reconnect: (access) =>
          HostedObservability.observe(
            "attach",
            Object.assign(
              {
                assignmentId: access.fence.assignmentId,
                sandboxId: access.fence.instanceId,
              },
              access.fence.target === "orb" ? { buildId: options.templateBuildId } : undefined,
            ),
            reconnect(access),
          ),
        validateAccess,
        heartbeat: (input) =>
          HostedObservability.observe(
            "attach",
            { assignmentId: input.access.fence.assignmentId, sandboxId: input.access.fence.instanceId },
            heartbeat(input),
          ).pipe(
            Effect.tapError((error) =>
              error.kind === "fenced" || error.kind === "lease-expired"
                ? HostedObservability.health("stale_lease", {
                    assignmentId: input.access.fence.assignmentId,
                    sandboxId: input.access.fence.instanceId,
                  })
                : Effect.void,
            ),
          ),
        checkpoint: (access, staged) =>
          HostedObservability.observe(
            "attach",
            {
              assignmentId: access.fence.assignmentId,
              sandboxId: access.fence.instanceId,
              checkpointId: staged.checkpointId,
            },
            checkpoint(access, staged),
          ),
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
