import { Function } from "effect"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptCorrelation from "@rika/transcript/child-parent-correlation"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as IngestProjection from "./execution-projection-state"
import type { Attachment } from "./execution-projection-types"
import type { Node, InterruptedOutcome } from "./execution-ingest-state"

export interface Restored {
  readonly nodes: Map<string, Node>
  readonly order: Array<string>
  readonly invalid?: string
}

const childProjectionOf = (
  key: string,
  units: ReadonlyArray<TranscriptUnit.Unit>,
  state?: TranscriptProjectionModel.ProjectionState,
): TranscriptProjectionModel.Projection =>
  state === undefined ? TranscriptProjection.Projection.empty(key, "") : { units, ...state }

const rootProjectionOf = (
  turn: Turn.AgentExecutionTurn,
  stored: TranscriptPage.Projection,
  state: TranscriptProjectionModel.ProjectionState,
): TranscriptProjectionModel.Projection | string => {
  const rootUnits = stored.units.filter((unit) => unit.parentId === undefined)
  if (rootUnits.some((unit) => unit.turnId !== turn.id)) return `Transcript ${turn.id} has a foreign root unit`
  if (stored.units.some((unit) => unit.parentId !== undefined && unit.turnId === turn.id))
    return `Transcript ${turn.id} has a root unit attached beneath another execution`
  const promptKey = `turn:${String(turn.id)}:user`
  const expectedPrompt = TranscriptProjection.Projection.empty(String(turn.id), turn.prompt).units[0]!
  const prompts = rootUnits.filter((unit) => unit.key === promptKey)
  if (prompts.length !== 1) return `Transcript ${turn.id} has no unique root prompt`
  const prompt = prompts[0]!
  if (
    prompt.content._tag !== "Entry" ||
    prompt.content.role !== "user" ||
    prompt.content.text !== turn.prompt ||
    TranscriptOrdering.compareUnitOrder(prompt.order, expectedPrompt.order) !== 0
  )
    return `Transcript ${turn.id} has a contradictory root prompt`
  return { units: rootUnits, ...state }
}

const restoreImpl = (turn: Turn.AgentExecutionTurn, stored: TranscriptPage.Projection | undefined): Restored => {
  const rootKey = TranscriptCorrelation.executionKey(String(turn.id))
  const checkpoints = new Map(
    (stored?.executionCheckpoints ?? []).map((checkpoint) => [checkpoint.executionKey, checkpoint]),
  )
  const rootCheckpoint = checkpoints.get(rootKey)
  if (stored !== undefined && rootCheckpoint === undefined)
    return { nodes: new Map(), order: [], invalid: `Transcript ${turn.id} has no root execution checkpoint` }
  if (rootCheckpoint?.attachment !== undefined)
    return { nodes: new Map(), order: [], invalid: `Transcript ${turn.id} has an attached root execution checkpoint` }
  if (
    stored !== undefined &&
    rootCheckpoint !== undefined &&
    !TranscriptProjection.Projection.sameProjectionState(
      TranscriptProjection.Projection.projectionState(stored),
      rootCheckpoint.state,
    )
  )
    return { nodes: new Map(), order: [], invalid: `Transcript ${turn.id} has contradictory root checkpoint state` }
  const rootCursor =
    rootCheckpoint === undefined || rootCheckpoint.cursor.length === 0 ? undefined : rootCheckpoint.cursor
  const rootProjection =
    stored === undefined || rootCheckpoint === undefined
      ? TranscriptProjection.Projection.empty(String(turn.id), turn.prompt)
      : rootProjectionOf(turn, stored, rootCheckpoint.state)
  if (typeof rootProjection === "string") return { nodes: new Map(), order: [], invalid: rootProjection }
  const root: Node = {
    executionId: rootCheckpoint?.executionId ?? String(turn.id),
    key: rootKey,
    parentKey: undefined,
    fold: TranscriptProjection.Fold.restoreProjectionFold(rootProjection),
    durableCursors: new Map(rootCursor === undefined ? [] : [[rootCursor, rootCheckpoint!.sequence]]),
    cursor: rootCursor,
    sequence: rootCheckpoint?.sequence ?? -1,
    status: rootCheckpoint?.status,
    resumed: false,
    caught: false,
    attachment: undefined,
  }
  const nodes = new Map<string, Node>([[rootKey, root]])
  const order = [rootKey]
  const groups = new Map<string, Array<TranscriptUnit.Unit>>()
  for (const unit of stored?.units ?? []) {
    if (unit.parentId === undefined) continue
    const key = TranscriptCorrelation.executionKey(unit.turnId)
    const group = groups.get(key)
    const local = IngestProjection.localizeUnit(unit)
    if (group === undefined) groups.set(key, [local])
    else group.push(local)
  }
  const candidates = new Set<string>([...groups.keys(), ...checkpoints.keys()])
  candidates.delete(rootKey)
  let remaining = [...candidates]
  while (remaining.length > 0) {
    const unresolved: Array<string> = []
    for (const key of remaining) {
      const checkpoint = checkpoints.get(key)
      const units = groups.get(key) ?? []
      if (checkpoint === undefined || checkpoint.attachment === undefined) {
        unresolved.push(key)
        continue
      }
      const parent = nodes.get(checkpoint.attachment.parentExecutionKey)
      const parentUnit = stored?.units.find((unit) => unit.key === checkpoint.attachment!.parentUnitKey)
      if (parent === undefined || parentUnit === undefined) {
        unresolved.push(key)
        continue
      }
      if (
        parentUnit.content._tag !== "Block" ||
        parentUnit.content.block._tag !== "ToolCall" ||
        parentUnit.content.block.id !== checkpoint.attachment.parentId ||
        TranscriptOrdering.encodeUnitOrder(parentUnit.order) !== checkpoint.attachment.parentOrderKey
      )
        return { nodes, order, invalid: `Transcript ${turn.id} has contradictory durable attachment for ${key}` }
      const cursor = checkpoint.cursor.length === 0 ? undefined : checkpoint.cursor
      nodes.set(key, {
        executionId: checkpoint.executionId,
        key,
        parentKey: checkpoint.attachment.parentExecutionKey,
        fold: TranscriptProjection.Fold.restoreProjectionFold(childProjectionOf(key, units, checkpoint.state)),
        durableCursors: new Map(cursor === undefined ? [] : [[cursor, checkpoint.sequence]]),
        cursor,
        sequence: checkpoint.sequence,
        status: checkpoint.status,
        resumed: false,
        caught: false,
        attachment: {
          parentId: checkpoint.attachment.parentId,
          parentUnitKey: parentUnit.key,
          parentToolId: checkpoint.attachment.parentId,
          parentOrder: parentUnit.order,
        },
      })
      order.push(key)
    }
    if (unresolved.length === remaining.length)
      return {
        nodes,
        order,
        invalid: `Transcript ${turn.id} has unattached execution checkpoints: ${unresolved.join(", ")}`,
      }
    remaining = unresolved
  }
  return { nodes, order }
}

export const restore: {
  (arg1: TranscriptPage.Projection | undefined): (arg0: Turn.AgentExecutionTurn) => ReturnType<typeof restoreImpl>
  (arg0: Turn.AgentExecutionTurn, arg1: TranscriptPage.Projection | undefined): ReturnType<typeof restoreImpl>
} = Function.dual(2, restoreImpl)

const validateStoredAttachmentsImpl = (
  turn: Turn.AgentExecutionTurn,
  stored: TranscriptPage.Projection,
  nodes: ReadonlyMap<string, Node>,
  attachments: ReadonlyMap<string, Attachment>,
): string | undefined => {
  const persisted = new Map(stored.units.map((unit) => [unit.key, unit]))
  for (const [key, node] of nodes) {
    if (node.parentKey === undefined) continue
    const attachment = attachments.get(key)
    if (attachment === undefined) return `Transcript ${turn.id} has no durable attachment for ${key}`
    for (const unit of TranscriptProjection.Fold.foldUnits(node.fold)) {
      const actual = persisted.get(unit.key)
      const expected = IngestProjection.globalizeUnit(node, unit, attachment)
      if (
        actual === undefined ||
        actual.turnId !== expected.turnId ||
        actual.parentId !== expected.parentId ||
        TranscriptOrdering.encodeUnitOrder(actual.order) !== TranscriptOrdering.encodeUnitOrder(expected.order)
      )
        return `Transcript ${turn.id} has a contradictory durable attachment for ${key}`
    }
  }
  return undefined
}

export const validateStoredAttachments: {
  (
    arg1: TranscriptPage.Projection,
    arg2: ReadonlyMap<string, Node>,
    arg3: ReadonlyMap<string, Attachment>,
  ): (arg0: Turn.AgentExecutionTurn) => ReturnType<typeof validateStoredAttachmentsImpl>
  (
    arg0: Turn.AgentExecutionTurn,
    arg1: TranscriptPage.Projection,
    arg2: ReadonlyMap<string, Node>,
    arg3: ReadonlyMap<string, Attachment>,
  ): ReturnType<typeof validateStoredAttachmentsImpl>
} = Function.dual(4, validateStoredAttachmentsImpl)

const interruptedAncestorOutcomeImpl = (
  nodes: ReadonlyMap<string, Node>,
  node: Node,
  isInterrupted: (outcome: NonNullable<TranscriptUnit.Unit["executionOutcome"]>) => outcome is InterruptedOutcome,
): InterruptedOutcome | undefined => {
  let parentKey = node.parentKey
  while (parentKey !== undefined) {
    const parent = nodes.get(parentKey)
    if (parent === undefined) return undefined
    const outcome = TranscriptProjection.Fold.foldExecutionOutcome(parent.fold)
    if (outcome !== undefined && isInterrupted(outcome)) return outcome
    parentKey = parent.parentKey
  }
  return undefined
}

export const interruptedAncestorOutcome: {
  (
    arg1: Node,
    arg2: (outcome: NonNullable<TranscriptUnit.Unit["executionOutcome"]>) => outcome is InterruptedOutcome,
  ): (arg0: ReadonlyMap<string, Node>) => ReturnType<typeof interruptedAncestorOutcomeImpl>
  (
    arg0: ReadonlyMap<string, Node>,
    arg1: Node,
    arg2: (outcome: NonNullable<TranscriptUnit.Unit["executionOutcome"]>) => outcome is InterruptedOutcome,
  ): ReturnType<typeof interruptedAncestorOutcomeImpl>
} = Function.dual(3, interruptedAncestorOutcomeImpl)

export const hasRunningUnits = (fold: TranscriptProjection.ProjectionFold): boolean =>
  TranscriptProjection.Fold.foldHasRunningUnits(fold)
export const executionOutcome = (fold: TranscriptProjection.ProjectionFold) =>
  TranscriptProjection.Fold.foldExecutionOutcome(fold)
const applyChildOutcomeImpl = (
  fold: TranscriptProjection.ProjectionFold,
  childExecutionId: string,
  outcome: NonNullable<TranscriptUnit.Unit["executionOutcome"]>,
) => TranscriptProjection.Fold.applyChildOutcome(fold, childExecutionId, outcome)

export const applyChildOutcome: {
  (
    arg1: string,
    arg2: NonNullable<TranscriptUnit.Unit["executionOutcome"]>,
  ): (arg0: TranscriptProjection.ProjectionFold) => ReturnType<typeof applyChildOutcomeImpl>
  (
    arg0: TranscriptProjection.ProjectionFold,
    arg1: string,
    arg2: NonNullable<TranscriptUnit.Unit["executionOutcome"]>,
  ): ReturnType<typeof applyChildOutcomeImpl>
} = Function.dual(3, applyChildOutcomeImpl)
export const units = (fold: TranscriptProjection.ProjectionFold) => TranscriptProjection.Fold.foldUnits(fold)
