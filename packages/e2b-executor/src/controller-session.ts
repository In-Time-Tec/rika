import type { ExecutorAssignment, OrbPlacement } from "@rika/product/executor-assignment"
import type { AssignmentsService, Access } from "@rika/product/executor-assignments"
import {
  AssignmentLeaseEpoch,
  CheckpointId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  Sequence,
} from "@rika/product/hosted-model"
import type { Access as ProtocolAccess, CheckpointProposal, Heartbeat, Hello } from "@rika/remote-execution/protocol"
import { Effect, Redacted, Schema } from "effect"
import { StoredArchive, type VaultInterface } from "./checkpoint"
import { ControllerError } from "./controller-contract"
import { assignmentFailure, epochMillis, failures, number, providerFailure, version } from "./controller-model"
import type { Interface as ProviderInterface } from "./provider"

const failure = failures.make

interface SessionContext {
  readonly assignments: AssignmentsService
  readonly provider: ProviderInterface
  readonly vault: VaultInterface
  readonly idleTimeoutMillis: number
  readonly heartbeatIntervalMillis: number
  readonly leaseLifetimeMillis: number
  readonly digest: (secret: Redacted.Redacted<string>) => Effect.Effect<Redacted.Redacted<string>, ControllerError>
  readonly current: (key: {
    readonly assignmentId: string
    readonly generation: number
  }) => Effect.Effect<ExecutorAssignment, ControllerError>
  readonly approvedPlacement: (assignment: ExecutorAssignment) => Effect.Effect<OrbPlacement, ControllerError>
  readonly checkpointScope: (input: {
    readonly ownerId: string
    readonly threadId: string
    readonly assignmentId: string
    readonly generation: number
    readonly checkpointId: string
  }) => typeof input
}

export const sessionOperations = ({
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
}: SessionContext) => {
  const assignmentAccess = Effect.fn("Controller.assignmentAccess")(function* (
    input: ProtocolAccess,
  ): Effect.fn.Return<Access, ControllerError> {
    if (input.fence.target !== "orb") return yield* failure("fenced", "Executor target is not E2B")
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
    if (input.fence.target !== "orb") return yield* failure("fenced", "Executor target is not E2B")
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
    yield* provider.touch(active.lifecycle.providerInstanceId, idleTimeoutMillis).pipe(Effect.mapError(providerFailure))
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
    const staged = {
      version: 1 as const,
      checkpointId: proposal.checkpointId,
      objectKey: stored.objectKey,
      contentDigest: stored.contentDigest,
      sizeBytes: stored.sizeBytes,
      format: "tar.zst" as const,
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

  return { hello, reconnect, validateAccess, heartbeat, checkpoint, assignmentAccess }
}
