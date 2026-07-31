import { Catalog } from "@rika/coding-tools/coding-tool-catalog"
import { Function } from "effect"
import { foldOperations } from "./transcript-event-fold"
import type { FoldMutation } from "./transcript-event-fold"
const {
  applyFoldEvent: applyFoldEventImpl,
  applyAncestorOutcome,
  applyChildOutcome,
  foldExecutionOutcome,
  foldHasRunningUnits,
  foldUnit,
  foldUnits,
  isTransientEvent,
  makeProjectionFold,
  parentToolForChild,
  restoreProjectionFold,
  settleFoldChild,
  settleFoldRunning,
  snapshotFoldProjection,
  snapshotFoldState,
} = foldOperations
export const Fold = foldOperations
export type { FoldMutation, ProjectionFold } from "./transcript-event-fold"
export type { UnitDelta } from "./transcript-fold-state"
import type { Projection as ProjectionModel, ProjectionState } from "../schema/transcript-projection-model"
import type { SourceEvent } from "../schema/transcript-source-event"
import type { Unit } from "../schema/transcript-unit"
import { compareUnitOrder } from "../ordering/transcript-unit-order"

const changed = (mutation: FoldMutation): boolean =>
  mutation.stateChanged || mutation.units.upsert.length > 0 || mutation.units.remove.length > 0

const agentPresentation = (name: string) => Catalog.resolveAgentPresentation(name)

const agentPhrase = (input: Catalog.AgentPhrase): string => Catalog.agentPhrase(input)

const empty: {
  (turnId: string, prompt: string): ProjectionModel
  (prompt: string): (turnId: string) => ProjectionModel
} = Function.dual(
  2,
  (turnId: string, prompt: string): ProjectionModel => snapshotFoldProjection(makeProjectionFold(turnId, prompt)),
)

const applyEvent: {
  (projection: ProjectionModel, event: SourceEvent): ProjectionModel
  (event: SourceEvent): (projection: ProjectionModel) => ProjectionModel
} = Function.dual(2, (projection: ProjectionModel, event: SourceEvent): ProjectionModel => {
  const fold = restoreProjectionFold(projection)
  return changed(applyFoldEventImpl(fold, event)) ? snapshotFoldProjection(fold) : projection
})

const project: {
  (turnId: string, prompt: string, events: ReadonlyArray<SourceEvent>): ProjectionModel
  (prompt: string, events: ReadonlyArray<SourceEvent>): (turnId: string) => ProjectionModel
} = Function.dual(3, (turnId: string, prompt: string, events: ReadonlyArray<SourceEvent>): ProjectionModel => {
  const fold = makeProjectionFold(turnId, prompt)
  for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) applyFoldEventImpl(fold, event)
  return snapshotFoldProjection(fold)
})

const hasRunningBlocks = (projection: ProjectionModel): boolean =>
  projection.units.some(
    (candidate) =>
      candidate.content._tag === "Block" &&
      (candidate.content.block._tag === "ToolCall" || candidate.content.block._tag === "ChildAgent") &&
      candidate.content.block.status === "running",
  )

export interface ProjectionStateSource {
  readonly revision: number
  readonly modelPhase: number
  readonly usableCompletionSequence?: number | undefined
  readonly oldestCursor?: string | undefined
  readonly checkpointCursor?: string | undefined
  readonly costUsd?: number | undefined
  readonly usageCursors?: ReadonlyArray<string> | undefined
  readonly pricingVersion?: string | undefined
}

const projectionState = (projection: ProjectionStateSource): ProjectionState => ({
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

const sameOptionalArray = (left: ReadonlyArray<string> | undefined, right: ReadonlyArray<string> | undefined) =>
  left === undefined || right === undefined
    ? left === right
    : left.length === right.length && left.every((value, index) => value === right[index])

const sameProjectionState: {
  (left: ProjectionState, right: ProjectionState): boolean
  (right: ProjectionState): (left: ProjectionState) => boolean
} = Function.dual(
  2,
  (left: ProjectionState, right: ProjectionState): boolean =>
    left.revision === right.revision &&
    left.modelPhase === right.modelPhase &&
    left.usableCompletionSequence === right.usableCompletionSequence &&
    left.oldestCursor === right.oldestCursor &&
    left.checkpointCursor === right.checkpointCursor &&
    left.costUsd === right.costUsd &&
    sameOptionalArray(left.usageCursors, right.usageCursors) &&
    left.pricingVersion === right.pricingVersion,
)

interface AssistantOutputProjection {
  readonly units: ReadonlyArray<Unit>
  readonly usableCompletionSequence?: number | undefined
}

const finalAssistantOutput: {
  (projection: AssistantOutputProjection, turnId: string): string | undefined
  (turnId: string): (projection: AssistantOutputProjection) => string | undefined
} = Function.dual(2, (projection: AssistantOutputProjection, turnId: string): string | undefined => {
  const completionSequence = projection.usableCompletionSequence
  if (completionSequence === undefined) return undefined
  const rootUnits = projection.units.filter((unit) => unit.turnId === turnId && unit.order.length === 1)
  const latestToolOrder = rootUnits
    .filter((unit) => unit.content._tag === "Block" && unit.content.block._tag === "ToolCall")
    .toSorted((left, right) => compareUnitOrder(left.order, right.order))
    .at(-1)?.order
  return rootUnits
    .flatMap((unit) =>
      (latestToolOrder === undefined || compareUnitOrder(unit.order, latestToolOrder) > 0) &&
      unit.revision === completionSequence &&
      unit.content._tag === "Entry" &&
      unit.content.role === "assistant" &&
      unit.content.text.trim().length > 0
        ? [{ order: unit.order, text: unit.content.text }]
        : [],
    )
    .toSorted((left, right) => compareUnitOrder(left.order, right.order))
    .at(-1)?.text
})

export const Presentation = { agentPresentation, agentPhrase }
export const Projection = {
  applyEvent,
  empty,
  finalAssistantOutput,
  hasRunningBlocks,
  project,
  projectionState,
  sameProjectionState,
}
