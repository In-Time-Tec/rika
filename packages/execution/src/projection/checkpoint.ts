import * as Projection from "@rika/product/execution-projection"
import type { Unit } from "@rika/product/execution-transcript-contract"
import { Function, Schema } from "effect"
import { type Card, type Node } from "./model"
import { type AuthorizationState, type PersistedProjector, type ProjectorCore } from "./persistence"
import type { ProjectorRecoveryIndex } from "./projector-recovery"
import type { UsageAccounting } from "./usage"

export interface AuthorizationTarget {
  readonly runId: string
  readonly approvalId: string
}

const authorizationTargetImpl = (
  checkpoint: Projection.Checkpoint,
  authorizationId: string,
): AuthorizationTarget | undefined => {
  if (checkpoint.version !== Projection.projectionVersion) return undefined
  try {
    const parsed = JSON.parse(checkpoint.state) as Partial<PersistedProjector>
    if (!Array.isArray(parsed.authorizations)) return undefined
    for (const candidate of parsed.authorizations) {
      if (!Array.isArray(candidate) || candidate.length !== 2) continue
      const value = candidate[1] as Partial<AuthorizationState>
      if (
        value.authorizationId === authorizationId &&
        typeof value.rawRunId === "string" &&
        typeof value.approvalId === "string"
      )
        return { runId: value.rawRunId, approvalId: value.approvalId }
    }
    return undefined
  } catch {
    return undefined
  }
}

export const authorizationTarget: {
  (
    arg0: Parameters<typeof authorizationTargetImpl>[0],
    arg1: Parameters<typeof authorizationTargetImpl>[1],
  ): ReturnType<typeof authorizationTargetImpl>
  (
    arg1: Parameters<typeof authorizationTargetImpl>[1],
  ): (arg0: Parameters<typeof authorizationTargetImpl>[0]) => ReturnType<typeof authorizationTargetImpl>
} = Function.dual(2, authorizationTargetImpl)

export interface ProjectorCheckpointCodec {
  readonly serialize: () => string
  readonly restore: (resumeCheckpoint: Projection.Checkpoint) => void
}

export interface ProjectorCheckpointInput {
  readonly turnId: string
  readonly baselineUnits: ReadonlyArray<Unit>
  readonly core: ProjectorCore
  readonly usage: UsageAccounting
  readonly units: Map<string, Unit>
  readonly nodes: Map<string, Node>
  readonly cardsByInvocation: Map<string, Card>
  readonly cardsByChild: Map<string, Card>
  readonly authorizations: Map<string, AuthorizationState>
  readonly pendingSteering: Map<string, Projection.PendingSteering>
  readonly settledSteering: Map<string, Projection.SteeringDisposition>
  readonly recovery: ProjectorRecoveryIndex
}

export const makeProjectorCheckpointCodec = (input: ProjectorCheckpointInput): ProjectorCheckpointCodec => {
  const {
    turnId,
    baselineUnits,
    core,
    usage,
    units,
    nodes,
    cardsByInvocation,
    cardsByChild,
    authorizations,
    pendingSteering,
    settledSteering,
    recovery,
  } = input

  const serialize = (): string => {
    const persisted: PersistedProjector = {
      turnId,
      revision: core.revision,
      hasOlder: core.historyOmitted || recovery.retainedUnitCount() < units.size,
      rootStatus: core.rootStatus,
      ...(core.title === undefined ? {} : { title: core.title }),
      steeringMessages: core.steeringMessages,
      followUpMessages: core.followUpMessages,
      pendingSteering: [...pendingSteering.values()],
      settledSteering: [...settledSteering.values()],
      ...usage.persist(),
      nodes: recovery.persistedNodes(),
      cards: recovery.persistedCards(),
      authorizations: recovery.persistedAuthorizations(authorizations),
      runningCompactions: recovery.persistedCompactions(),
    }
    return JSON.stringify(persisted)
  }

  const restore = (resumeCheckpoint: Projection.Checkpoint): void => {
    const parsed = JSON.parse(resumeCheckpoint.state) as Partial<PersistedProjector>
    if (
      parsed.turnId !== turnId ||
      typeof parsed.hasOlder !== "boolean" ||
      !Number.isSafeInteger(parsed.revision) ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.cards) ||
      !Schema.is(Projection.UsageState)(parsed.usageState) ||
      !Number.isSafeInteger(parsed.requestOrdinal) ||
      !Array.isArray(parsed.attemptStarts) ||
      !Array.isArray(parsed.settledAttemptKeys) ||
      !Array.isArray(parsed.modelCalls) ||
      !Array.isArray(parsed.authorizations) ||
      !Array.isArray(parsed.runningCompactions) ||
      !Schema.is(Schema.Array(Projection.PendingSteering))(parsed.pendingSteering) ||
      !Schema.is(Schema.Array(Projection.SteeringDisposition))(parsed.settledSteering) ||
      typeof parsed.activeAvailable !== "boolean" ||
      !Number.isSafeInteger(parsed.activeDepth) ||
      typeof parsed.activeAccumulatedMillis !== "number" ||
      typeof parsed.steeringMessages !== "number" ||
      typeof parsed.followUpMessages !== "number"
    )
      throw new TypeError("Invalid TenetKit tree projector checkpoint")
    core.revision = parsed.revision!
    core.historyOmitted = parsed.hasOlder
    core.rootStatus = parsed.rootStatus ?? "running"
    core.title = parsed.title
    core.steeringMessages = parsed.steeringMessages
    core.followUpMessages = parsed.followUpMessages
    usage.restore({
      usageState: parsed.usageState,
      requestOrdinal: parsed.requestOrdinal!,
      ...(parsed.pendingContextOrdinal === undefined ? {} : { pendingContextOrdinal: parsed.pendingContextOrdinal }),
      attemptStarts: parsed.attemptStarts,
      settledAttemptKeys: parsed.settledAttemptKeys,
      modelCalls: parsed.modelCalls,
      activeAvailable: parsed.activeAvailable,
      activeDepth: parsed.activeDepth!,
      activeAccumulatedMillis: parsed.activeAccumulatedMillis,
      ...(parsed.activeSince === undefined ? {} : { activeSince: parsed.activeSince }),
      ...(parsed.lastLifecycleAt === undefined ? {} : { lastLifecycleAt: parsed.lastLifecycleAt }),
    })
    units.clear()
    for (const value of baselineUnits) {
      if (value.turnId !== turnId) throw new TypeError("Invalid projector baseline unit")
      units.set(value.key, value)
    }
    nodes.clear()
    for (const persisted of parsed.nodes) {
      if (typeof persisted.rawRunId !== "string" || typeof persisted.publicId !== "string")
        throw new TypeError("Invalid projector topology checkpoint")
      const node: Node = {
        rawRunId: persisted.rawRunId,
        publicId: persisted.publicId,
        ...(persisted.parentRawRunId === undefined ? {} : { parentRawRunId: persisted.parentRawRunId }),
        ...(persisted.parentUnitKey === undefined ? {} : { parentUnitKey: persisted.parentUnitKey }),
        ...(persisted.parentBlockId === undefined ? {} : { parentBlockId: persisted.parentBlockId }),
        hidden: persisted.hidden,
        tools: new Map(persisted.tools),
        cells: new Map(persisted.cells),
        phase: persisted.phase,
        status: persisted.status,
        lifecycle: persisted.lifecycle,
        started: persisted.started,
        ...(persisted.attempt === undefined ? {} : { attempt: persisted.attempt }),
      }
      nodes.set(node.rawRunId, node)
      recovery.nodeChanged(node)
      for (const tool of node.tools.values()) recovery.toolChanged(node, tool, true)
      for (const cell of node.cells.values()) recovery.cellChanged(node, cell, true)
    }
    cardsByInvocation.clear()
    cardsByChild.clear()
    for (const persisted of parsed.cards) {
      const candidate = units.get(persisted.unitKey)
      const block =
        candidate?.content._tag === "Block" && candidate.content.block._tag === "SubagentCard"
          ? candidate.content.block
          : undefined
      const card: Card = {
        ...persisted,
        prompt: block?.prompt ?? "",
        promptTruncated: block?.promptTruncated ?? persisted.promptTruncated,
      }
      cardsByInvocation.set(`${card.parentRawRunId}\u0000${card.rawInvocationId}`, card)
      if (card.rawChildRunId !== undefined) cardsByChild.set(card.rawChildRunId, card)
      recovery.cardChanged(card)
    }
    authorizations.clear()
    for (const [key, value] of parsed.authorizations) {
      authorizations.set(key, value)
      recovery.authorizationChanged(key, value.unitKey)
    }
    for (const key of parsed.runningCompactions) {
      if (typeof key !== "string") throw new TypeError("Invalid projector compaction checkpoint")
      recovery.compactionChanged(key, true)
    }
    pendingSteering.clear()
    for (const value of parsed.pendingSteering) pendingSteering.set(`${value.runId}\u0000${value.entryId}`, value)
    settledSteering.clear()
    for (const value of parsed.settledSteering) settledSteering.set(`${value.runId}\u0000${value.entryId}`, value)
    core.checkpoint = resumeCheckpoint
  }

  return { serialize, restore }
}
