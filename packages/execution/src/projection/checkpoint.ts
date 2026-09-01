import * as Projection from "@rika/product/execution-projection"
import type { Unit } from "@rika/product/execution-transcript-contract"
import { Function, Schema } from "effect"
import type { Card, Node } from "./model"
import type { AuthorizationState, PersistedProjector, ProjectorCore } from "./persistence"
import type { ProjectorRecoveryIndex } from "./tree/projector-recovery"
import type { UsageAccounting } from "./usage"

const AuthorizationStateSchema = Schema.Struct({
  unitKey: Schema.String,
  rawRunId: Schema.String,
  authorizationId: Schema.String,
  approvalId: Schema.String,
})

const AuthorizationCheckpointSchema = Schema.Struct({
  authorizations: Schema.Array(Schema.Tuple([Schema.String, AuthorizationStateSchema])),
})

const ToolStateSchema = Schema.Struct({ rawId: Schema.String, key: Schema.String, blockId: Schema.String })
const NodeSchema = Schema.Struct({
  rawRunId: Schema.String,
  publicId: Schema.String,
  parentRawRunId: Schema.optionalKey(Schema.String),
  parentUnitKey: Schema.optionalKey(Schema.String),
  parentBlockId: Schema.optionalKey(Schema.String),
  hidden: Schema.Boolean,
  phase: Schema.Finite,
  status: Schema.Literals(["running", "waiting", "completed", "failed", "cancelled"]),
  lifecycle: Schema.Literals(["unknown", "accepted", "active", "waiting", "terminal"]),
  started: Schema.Boolean,
  attempt: Schema.optionalKey(Schema.Finite),
  tools: Schema.Array(Schema.Tuple([Schema.String, ToolStateSchema])),
})
const CardSchema = Schema.Struct({
  parentRawRunId: Schema.String,
  rawInvocationId: Schema.String,
  publicId: Schema.String,
  unitKey: Schema.String,
  blockId: Schema.String,
  selection: Schema.String,
  label: Schema.optionalKey(Schema.String),
  promptTruncated: Schema.Boolean,
  memberKey: Schema.optionalKey(Schema.String),
  rawChildRunId: Schema.optionalKey(Schema.String),
})
const AttemptStartSchema = Schema.Struct({
  startedAt: Schema.Finite,
  modelCallId: Schema.String,
  rawRunId: Schema.String,
})
const ModelCallStateSchema = Schema.Struct({
  purpose: Schema.Literals(["conversation", "structured-output", "compaction-summary"]),
  requestOrdinal: Schema.optionalKey(Schema.Finite),
})
const PersistedProjectorSchema = Schema.Struct({
  turnId: Schema.String,
  revision: Schema.Finite,
  hasOlder: Schema.Boolean,
  rootStatus: Projection.ProjectionState.fields.status,
  title: Schema.optionalKey(Projection.GeneratedTitle),
  steeringMessages: Schema.Finite,
  followUpMessages: Schema.Finite,
  pendingSteering: Schema.Array(Projection.PendingSteering),
  settledSteering: Schema.Array(Projection.SteeringDisposition),
  usageState: Projection.UsageState,
  requestOrdinal: Schema.Finite,
  pendingContextOrdinal: Schema.optionalKey(Schema.Finite),
  attemptStarts: Schema.Array(Schema.Tuple([Schema.String, AttemptStartSchema])),
  settledAttemptKeys: Schema.Array(Schema.String),
  modelCalls: Schema.Array(Schema.Tuple([Schema.String, ModelCallStateSchema])),
  activeAvailable: Schema.Boolean,
  activeDepth: Schema.Finite,
  activeAccumulatedMillis: Schema.Finite,
  activeSince: Schema.optionalKey(Schema.Finite),
  lastLifecycleAt: Schema.optionalKey(Schema.Finite),
  nodes: Schema.Array(NodeSchema),
  cards: Schema.Array(CardSchema),
  authorizations: Schema.Array(Schema.Tuple([Schema.String, AuthorizationStateSchema])),
  runningCompactions: Schema.Array(Schema.String),
})

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
    const parsed = Schema.decodeSync(Schema.fromJsonString(AuthorizationCheckpointSchema))(checkpoint.state)
    for (const [, value] of parsed.authorizations) {
      if (value.authorizationId === authorizationId) return { runId: value.rawRunId, approvalId: value.approvalId }
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
    const persisted = Object.assign(
      {
        turnId,
        revision: core.revision,
        hasOlder: core.historyOmitted || recovery.retainedUnitCount() < units.size,
        rootStatus: core.rootStatus,
        steeringMessages: core.steeringMessages,
        followUpMessages: core.followUpMessages,
        pendingSteering: [...pendingSteering.values()],
        settledSteering: [...settledSteering.values()],
        ...usage.persist(),
        nodes: recovery.persistedNodes(),
        cards: recovery.persistedCards(),
        authorizations: recovery.persistedAuthorizations(authorizations),
        runningCompactions: recovery.persistedCompactions(),
      },
      core.title === undefined ? undefined : { title: core.title },
    ) satisfies PersistedProjector
    return JSON.stringify(persisted)
  }

  const restoreNodes = (persistedNodes: ReadonlyArray<typeof NodeSchema.Type>): void => {
    nodes.clear()
    for (const persisted of persistedNodes) {
      const node: Node = {
        rawRunId: persisted.rawRunId,
        publicId: persisted.publicId,
        hidden: persisted.hidden,
        tools: new Map(persisted.tools),
        phase: persisted.phase,
        status: persisted.status,
        lifecycle: persisted.lifecycle,
        started: persisted.started,
      }
      if (persisted.parentRawRunId !== undefined) Object.assign(node, { parentRawRunId: persisted.parentRawRunId })
      if (persisted.parentUnitKey !== undefined) Object.assign(node, { parentUnitKey: persisted.parentUnitKey })
      if (persisted.parentBlockId !== undefined) Object.assign(node, { parentBlockId: persisted.parentBlockId })
      if (persisted.attempt !== undefined) Object.assign(node, { attempt: persisted.attempt })
      nodes.set(node.rawRunId, node)
      recovery.nodeChanged(node)
      for (const tool of node.tools.values()) recovery.toolChanged(node, tool, true)
    }
  }

  const restoreCards = (persistedCards: ReadonlyArray<typeof CardSchema.Type>): void => {
    cardsByInvocation.clear()
    cardsByChild.clear()
    for (const persisted of persistedCards) {
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
  }

  const restore = (resumeCheckpoint: Projection.Checkpoint): void => {
    const parsed = Schema.decodeSync(Schema.fromJsonString(PersistedProjectorSchema))(resumeCheckpoint.state)
    if (
      parsed.turnId !== turnId ||
      !Number.isSafeInteger(parsed.revision) ||
      !Number.isSafeInteger(parsed.requestOrdinal) ||
      !Number.isSafeInteger(parsed.activeDepth)
    )
      throw new TypeError("Invalid Generalist tree projector checkpoint")
    core.revision = parsed.revision
    core.historyOmitted = parsed.hasOlder
    core.rootStatus = parsed.rootStatus ?? "running"
    core.title = parsed.title
    core.steeringMessages = parsed.steeringMessages
    core.followUpMessages = parsed.followUpMessages
    const persistedUsage = {
      usageState: parsed.usageState,
      requestOrdinal: parsed.requestOrdinal,
      attemptStarts: parsed.attemptStarts,
      settledAttemptKeys: parsed.settledAttemptKeys,
      modelCalls: parsed.modelCalls,
      activeAvailable: parsed.activeAvailable,
      activeDepth: parsed.activeDepth,
      activeAccumulatedMillis: parsed.activeAccumulatedMillis,
    }
    if (parsed.pendingContextOrdinal !== undefined)
      Object.assign(persistedUsage, { pendingContextOrdinal: parsed.pendingContextOrdinal })
    if (parsed.activeSince !== undefined) Object.assign(persistedUsage, { activeSince: parsed.activeSince })
    if (parsed.lastLifecycleAt !== undefined) Object.assign(persistedUsage, { lastLifecycleAt: parsed.lastLifecycleAt })
    usage.restore(persistedUsage)
    units.clear()
    for (const value of baselineUnits) {
      if (value.turnId !== turnId) throw new TypeError("Invalid projector baseline unit")
      units.set(value.key, value)
    }
    restoreNodes(parsed.nodes)
    restoreCards(parsed.cards)
    authorizations.clear()
    for (const [key, value] of parsed.authorizations) {
      authorizations.set(key, value)
      recovery.authorizationChanged(key, value.unitKey)
    }
    for (const key of parsed.runningCompactions) {
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
