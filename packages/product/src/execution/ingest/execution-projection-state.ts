import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptProjection from "@rika/transcript/transcript-projection"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Function } from "effect"
import type { ProjectionOrigin, VisibleState } from "./execution-projection-contract"
import type { Attachment, ProjectionDelta, ProjectionNode, VisibleDelta } from "./execution-projection-types"

export const visibleState = (fold: TranscriptProjection.ProjectionFold): VisibleState => {
  const state = TranscriptProjection.Fold.snapshotFoldState(fold)
  return {
    revision: state.revision,
    modelPhase: state.modelPhase,
    ...(state.usableCompletionSequence === undefined
      ? {}
      : { usableCompletionSequence: state.usableCompletionSequence }),
  }
}

const text = (event: TranscriptSourceEvent.SourceEvent): string | undefined => {
  if (typeof event.text === "string") return event.text
  return typeof event.data?.delta === "string" ? event.data.delta : undefined
}

const blockId = (event: TranscriptSourceEvent.SourceEvent): string | undefined => {
  const id = event.data?.tool_call_id ?? event.data?.call_id ?? event.data?.id
  return typeof id === "string" ? id : undefined
}

const steeringSequences = (event: TranscriptSourceEvent.SourceEvent): ReadonlyArray<number> | undefined => {
  if (event.type !== "steering.delivered") return undefined
  const value = event.data?.message_sequences
  if (!Array.isArray(value)) return undefined
  const sequences = value.filter((item): item is number => Number.isSafeInteger(item))
  return sequences.length === 0 ? undefined : sequences
}

export const eventOrigin: {
  (executionId: string, event: TranscriptSourceEvent.SourceEvent): ProjectionOrigin
  (event: TranscriptSourceEvent.SourceEvent): (executionId: string) => ProjectionOrigin
} = Function.dual(2, (executionId: string, event: TranscriptSourceEvent.SourceEvent): ProjectionOrigin => {
  const eventText = text(event)
  const eventBlockId = blockId(event)
  const eventSteeringSequences = steeringSequences(event)
  return {
    _tag: "Event",
    executionId,
    cursor: event.cursor,
    sequence: event.sequence,
    type: event.type,
    createdAt: event.createdAt,
    transient: TranscriptProjection.Fold.isTransientEvent(event),
    ...(eventText === undefined ? {} : { text: eventText }),
    ...(eventBlockId === undefined ? {} : { blockId: eventBlockId }),
    ...(eventSteeringSequences === undefined ? {} : { steeringSequences: eventSteeringSequences }),
  }
})

export const recordVisibleMutation: {
  (delta: VisibleDelta, owner: string, mutation: TranscriptProjection.FoldMutation): void
  (owner: string, mutation: TranscriptProjection.FoldMutation): (delta: VisibleDelta) => void
} = Function.dual(3, (delta: VisibleDelta, owner: string, mutation: TranscriptProjection.FoldMutation): void => {
  for (const key of mutation.units.remove) delta.set(key, { owner })
  for (const unit of mutation.units.upsert) delta.set(unit.key, { owner, unit })
})

export const globalDelta: {
  (
    nodes: ReadonlyMap<string, ProjectionNode>,
    delta: VisibleDelta,
    attachments: ReadonlyMap<string, Attachment>,
  ): TranscriptProjection.UnitDelta
  (
    delta: VisibleDelta,
    attachments: ReadonlyMap<string, Attachment>,
  ): (nodes: ReadonlyMap<string, ProjectionNode>) => TranscriptProjection.UnitDelta
} = Function.dual(
  3,
  (
    nodes: ReadonlyMap<string, ProjectionNode>,
    delta: VisibleDelta,
    attachments: ReadonlyMap<string, Attachment>,
  ): TranscriptProjection.UnitDelta => {
    const upsert: Array<TranscriptUnit.Unit> = []
    const remove: Array<string> = []
    for (const [key, mutation] of delta) {
      const node = nodes.get(mutation.owner)
      if (node === undefined || (node.parentKey !== undefined && !attachments.has(node.key))) continue
      if (mutation.unit === undefined) remove.push(key)
      else upsert.push(globalizeUnit(node, mutation.unit, attachments.get(node.key)))
    }
    return { upsert, remove }
  },
)

export const localizeUnit = (unit: TranscriptUnit.Unit): TranscriptUnit.Unit => {
  const { parentId: _parentId, ...local } = unit
  return { ...local, order: TranscriptOrdering.localOrder(unit.order) }
}

export const globalizeUnit: {
  (node: ProjectionNode, unit: TranscriptUnit.Unit, attachment: Attachment | undefined): TranscriptUnit.Unit
  (unit: TranscriptUnit.Unit, attachment: Attachment | undefined): (node: ProjectionNode) => TranscriptUnit.Unit
} = Function.dual(
  3,
  (node: ProjectionNode, unit: TranscriptUnit.Unit, attachment: Attachment | undefined): TranscriptUnit.Unit => {
    const local = localizeUnit(unit)
    return attachment === undefined
      ? local
      : {
          ...local,
          parentId: attachment.parentId,
          order: TranscriptOrdering.childOrder(attachment.parentOrder, node.executionId, local.order),
        }
  },
)

export const globalProjectionUnits: {
  (
    nodes: ReadonlyMap<string, ProjectionNode>,
    order: ReadonlyArray<string>,
    attachments: ReadonlyMap<string, Attachment>,
  ): ReadonlyArray<TranscriptUnit.Unit>
  (
    order: ReadonlyArray<string>,
    attachments: ReadonlyMap<string, Attachment>,
  ): (nodes: ReadonlyMap<string, ProjectionNode>) => ReadonlyArray<TranscriptUnit.Unit>
} = Function.dual(
  3,
  (
    nodes: ReadonlyMap<string, ProjectionNode>,
    order: ReadonlyArray<string>,
    attachments: ReadonlyMap<string, Attachment>,
  ): ReadonlyArray<TranscriptUnit.Unit> =>
    order
      .flatMap((key) => {
        const node = nodes.get(key)
        return node === undefined
          ? []
          : TranscriptProjection.Fold.foldUnits(node.fold).map((unit) =>
              globalizeUnit(node, unit, attachments.get(key)),
            )
      })
      .toSorted((left, right) => TranscriptOrdering.compareUnitOrder(left.order, right.order)),
)
