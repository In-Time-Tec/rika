import { Function } from "effect"
import {
  applyFoldEvent,
  makeProjectionFold,
  restoreProjectionFold,
  snapshotFoldProjection,
  type FoldMutation,
} from "./fold"
import { compareUnitOrder } from "./unit-order"
import type { Projection, ProjectionState, SourceEvent, Unit } from "./schema"

const changed = (mutation: FoldMutation): boolean =>
  mutation.stateChanged || mutation.units.upsert.length > 0 || mutation.units.remove.length > 0

export const empty: {
  (turnId: string, prompt: string): Projection
  (prompt: string): (turnId: string) => Projection
} = Function.dual(
  2,
  (turnId: string, prompt: string): Projection => snapshotFoldProjection(makeProjectionFold(turnId, prompt)),
)

export const applyEvent: {
  (projection: Projection, event: SourceEvent): Projection
  (event: SourceEvent): (projection: Projection) => Projection
} = Function.dual(2, (projection: Projection, event: SourceEvent): Projection => {
  const fold = restoreProjectionFold(projection)
  return changed(applyFoldEvent(fold, event)) ? snapshotFoldProjection(fold) : projection
})

export const project: {
  (turnId: string, prompt: string, events: ReadonlyArray<SourceEvent>): Projection
  (prompt: string, events: ReadonlyArray<SourceEvent>): (turnId: string) => Projection
} = Function.dual(3, (turnId: string, prompt: string, events: ReadonlyArray<SourceEvent>): Projection => {
  const fold = makeProjectionFold(turnId, prompt)
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) applyFoldEvent(fold, event)
  return snapshotFoldProjection(fold)
})

export const hasRunningBlocks = (projection: Projection): boolean =>
  projection.units.some(
    (candidate) =>
      candidate.content._tag === "Block" &&
      (candidate.content.block._tag === "ToolCall" || candidate.content.block._tag === "ChildAgent") &&
      candidate.content.block.status === "running",
  )

export interface ProjectionStateSource {
  readonly revision: number
  readonly modelPhase: number
  readonly usableCompletionSequence?: number
  readonly oldestCursor?: string
  readonly checkpointCursor?: string
  readonly costUsd?: number
  readonly usageCursors?: ReadonlyArray<string>
  readonly pricingVersion?: string
}
export const projectionState = (projection: ProjectionStateSource): ProjectionState => ({
  revision: projection.revision,
  modelPhase: projection.modelPhase,
  ...(projection.usableCompletionSequence === undefined
    ? {}
    : { usableCompletionSequence: projection.usableCompletionSequence }),
  ...(projection.oldestCursor === undefined ? {} : { oldestCursor: projection.oldestCursor }),
  ...(projection.checkpointCursor === undefined ? {} : { checkpointCursor: projection.checkpointCursor }),
  ...(projection.costUsd === undefined ? {} : { costUsd: projection.costUsd }),
  ...(projection.usageCursors === undefined ? {} : { usageCursors: projection.usageCursors }),
  ...(projection.pricingVersion === undefined ? {} : { pricingVersion: projection.pricingVersion }),
})

export const finalAssistantOutput: {
  (projection: Pick<Projection, "units" | "usableCompletionSequence">, turnId: string): string | undefined
  (turnId: string): (projection: Pick<Projection, "units" | "usableCompletionSequence">) => string | undefined
} = Function.dual(
  2,
  (projection: Pick<Projection, "units" | "usableCompletionSequence">, turnId: string): string | undefined => {
    const completionSequence = projection.usableCompletionSequence
    if (completionSequence === undefined) return undefined
    const units = projection.units.filter((unit) => unit.turnId === turnId && unit.order.length === 1)
    return units
      .filter(
        (
          unit,
        ): unit is Unit & {
          readonly content: { readonly _tag: "Entry"; readonly role: "assistant"; readonly text: string }
        } =>
          unit.revision === completionSequence &&
          unit.content._tag === "Entry" &&
          unit.content.role === "assistant" &&
          unit.content.text.trim().length > 0,
      )
      .toSorted((left, right) => compareUnitOrder(left.order, right.order))
      .at(-1)?.content.text
  },
)
