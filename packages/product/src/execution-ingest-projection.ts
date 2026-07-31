import * as Transcript from "@rika/transcript/transcript-unit"
import { Function } from "effect"
import type { ProjectionOrigin, VisibleState } from "./execution-ingest-projection-contract"

export * from "./execution-ingest-projection-contract"

export interface ProjectionNode {
  readonly executionId: string
  readonly key: string
  readonly parentKey: string | undefined
  fold: Transcript.ProjectionFold
}

export interface Attachment {
  readonly parentId: string
  readonly parentUnitKey: string
  readonly parentToolId: string
  readonly parentOrder: Transcript.UnitOrder
}

export interface ProjectionDelta {
  readonly units: Map<string, { readonly owner: string; readonly unit?: Transcript.Unit }>
  readonly checkpoints: Set<string>
}

export type VisibleDelta = Map<string, { readonly owner: string; readonly unit?: Transcript.Unit }>

export const visibleState = (fold: Transcript.ProjectionFold): VisibleState => {
  const state = Transcript.snapshotFoldState(fold)
  return {
    revision: state.revision,
    modelPhase: state.modelPhase,
    ...(state.usableCompletionSequence === undefined
      ? {}
      : { usableCompletionSequence: state.usableCompletionSequence }),
  }
}

const text = (event: Transcript.SourceEvent): string | undefined => {
  if (typeof event.text === "string") return event.text
  return typeof event.data?.delta === "string" ? event.data.delta : undefined
}

const blockId = (event: Transcript.SourceEvent): string | undefined => {
  const id = event.data?.tool_call_id ?? event.data?.call_id ?? event.data?.id
  return typeof id === "string" ? id : undefined
}

const steeringSequences = (event: Transcript.SourceEvent): ReadonlyArray<number> | undefined => {
  if (event.type !== "steering.delivered") return undefined
  const value = event.data?.message_sequences
  if (!Array.isArray(value)) return undefined
  const sequences = value.filter((item): item is number => Number.isSafeInteger(item))
  return sequences.length === 0 ? undefined : sequences
}

export const eventOrigin: {
  (executionId: string, event: Transcript.SourceEvent): ProjectionOrigin
  (event: Transcript.SourceEvent): (executionId: string) => ProjectionOrigin
} = Function.dual(2, (executionId: string, event: Transcript.SourceEvent): ProjectionOrigin => {
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
    transient: Transcript.isTransientEvent(event),
    ...(eventText === undefined ? {} : { text: eventText }),
    ...(eventBlockId === undefined ? {} : { blockId: eventBlockId }),
    ...(eventSteeringSequences === undefined ? {} : { steeringSequences: eventSteeringSequences }),
  }
})

export const recordVisibleMutation: {
  (delta: VisibleDelta, owner: string, mutation: Transcript.FoldMutation): void
  (owner: string, mutation: Transcript.FoldMutation): (delta: VisibleDelta) => void
} = Function.dual(3, (delta: VisibleDelta, owner: string, mutation: Transcript.FoldMutation): void => {
  for (const key of mutation.units.remove) delta.set(key, { owner })
  for (const unit of mutation.units.upsert) delta.set(unit.key, { owner, unit })
})

export const globalDelta: {
  (
    nodes: ReadonlyMap<string, ProjectionNode>,
    delta: VisibleDelta,
    attachments: ReadonlyMap<string, Attachment>,
  ): Transcript.UnitDelta
  (
    delta: VisibleDelta,
    attachments: ReadonlyMap<string, Attachment>,
  ): (nodes: ReadonlyMap<string, ProjectionNode>) => Transcript.UnitDelta
} = Function.dual(
  3,
  (
    nodes: ReadonlyMap<string, ProjectionNode>,
    delta: VisibleDelta,
    attachments: ReadonlyMap<string, Attachment>,
  ): Transcript.UnitDelta => {
    const upsert: Array<Transcript.Unit> = []
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

export const localizeUnit = (unit: Transcript.Unit): Transcript.Unit => {
  const { parentId: _parentId, ...local } = unit
  return { ...local, order: Transcript.localOrder(unit.order) }
}

export const globalizeUnit: {
  (node: ProjectionNode, unit: Transcript.Unit, attachment: Attachment | undefined): Transcript.Unit
  (unit: Transcript.Unit, attachment: Attachment | undefined): (node: ProjectionNode) => Transcript.Unit
} = Function.dual(
  3,
  (node: ProjectionNode, unit: Transcript.Unit, attachment: Attachment | undefined): Transcript.Unit => {
    const local = localizeUnit(unit)
    return attachment === undefined
      ? local
      : {
          ...local,
          parentId: attachment.parentId,
          order: Transcript.childOrder(attachment.parentOrder, node.executionId, local.order),
        }
  },
)

export const globalProjectionUnits: {
  (
    nodes: ReadonlyMap<string, ProjectionNode>,
    order: ReadonlyArray<string>,
    attachments: ReadonlyMap<string, Attachment>,
  ): ReadonlyArray<Transcript.Unit>
  (
    order: ReadonlyArray<string>,
    attachments: ReadonlyMap<string, Attachment>,
  ): (nodes: ReadonlyMap<string, ProjectionNode>) => ReadonlyArray<Transcript.Unit>
} = Function.dual(
  3,
  (
    nodes: ReadonlyMap<string, ProjectionNode>,
    order: ReadonlyArray<string>,
    attachments: ReadonlyMap<string, Attachment>,
  ): ReadonlyArray<Transcript.Unit> =>
    order
      .flatMap((key) => {
        const node = nodes.get(key)
        return node === undefined
          ? []
          : Transcript.foldUnits(node.fold).map((unit) => globalizeUnit(node, unit, attachments.get(key)))
      })
      .toSorted((left, right) => Transcript.compareUnitOrder(left.order, right.order)),
)
