import { Catalog } from "@rika/tools"
import { Function } from "effect"
import { childParentMatch, executionKey } from "./child-parent"
import {
  applyFoldEvent,
  isTransientEvent,
  makeProjectionFold,
  restoreProjectionFold,
  settleFoldChild,
  settleFoldRunning,
  snapshotFoldProjection,
  type FoldMutation,
} from "./fold"
import { pricingVersion, usageTokens } from "./model-cost"
import { partialInputRecord } from "./partial-input"
import type { Presentation, Projection, ProjectionState, SourceEvent, Unit } from "./schema"
import { childOrder, compareUnitOrder, localOrder } from "./unit-order"

export * from "./schema"
export * from "./unit-order"
export * from "./unit-identity"
export * from "./recorded-shell"
export { pricingVersion, usageInputTokens, usageTokens, type UsageTokens } from "./model-cost"
export { partialInputRecord } from "./partial-input"
export { childParentMatch, executionKey, isTransientEvent }
export {
  applyAncestorOutcome,
  applyChildOutcome,
  applyFoldEvent,
  foldExecutionOutcome,
  foldHasRunningUnits,
  foldUnit,
  foldUnits,
  makeProjectionFold,
  parentToolForChild,
  restoreProjectionFold,
  settleFoldRunning,
  snapshotFoldProjection,
  snapshotFoldState,
  type FoldMutation,
  type ProjectionFold,
  type UnitDelta,
} from "./fold"
export type { ChildParentCandidate } from "./child-parent"

export const agentPresentation = (name: string): Presentation => Catalog.resolveAgentPresentation(name)

export const agentPhrase = (input: Catalog.AgentPhrase): string => Catalog.agentPhrase(input)

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

export const settleRunning: {
  (projection: Projection, status: "failed" | "cancelled", sequence: number): Projection
  (status: "failed" | "cancelled", sequence: number): (projection: Projection) => Projection
} = Function.dual(3, (projection: Projection, status: "failed" | "cancelled", sequence: number): Projection => {
  const fold = restoreProjectionFold(projection)
  return changed(settleFoldRunning(fold, status, sequence)) ? snapshotFoldProjection(fold) : projection
})

export const settleChild: {
  (projection: Projection, childId: string, status: "complete" | "failed" | "cancelled", sequence: number): Projection
  (
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): (projection: Projection) => Projection
} = Function.dual(
  4,
  (
    projection: Projection,
    childId: string,
    status: "complete" | "failed" | "cancelled",
    sequence: number,
  ): Projection => {
    const fold = restoreProjectionFold(projection)
    return changed(settleFoldChild(fold, childId, status, sequence)) ? snapshotFoldProjection(fold) : projection
  },
)

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
  readonly usableCompletionSequence?: number | undefined
  readonly oldestCursor?: string | undefined
  readonly checkpointCursor?: string | undefined
  readonly costUsd?: number | undefined
  readonly usageCursors?: ReadonlyArray<string> | undefined
  readonly pricingVersion?: string | undefined
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

const sameOptionalArray = (left: ReadonlyArray<string> | undefined, right: ReadonlyArray<string> | undefined) =>
  left === undefined || right === undefined
    ? left === right
    : left.length === right.length && left.every((value, index) => value === right[index])

export const sameProjectionState: {
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

export const finalAssistantOutput: {
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

export interface NestedProjection {
  readonly parentId: string
  readonly projection: Projection
}

const toolUnitById = (units: Iterable<Unit>, id: string): Unit | undefined => {
  for (const unit of units)
    if (unit.content._tag === "Block" && unit.content.block._tag === "ToolCall" && unit.content.block.id === id)
      return unit
  return undefined
}

export const attachUnit: {
  (candidate: Unit, parent: Unit, parentId: string, childExecutionId: string): Unit
  (parent: Unit, parentId: string, childExecutionId: string): (candidate: Unit) => Unit
} = Function.dual(
  4,
  (candidate: Unit, parent: Unit, parentId: string, childExecutionId: string): Unit => ({
    ...candidate,
    parentId,
    order: childOrder(parent.order, childExecutionId, localOrder(candidate.order)),
  }),
)

export const withNestedProjections: {
  (root: Projection, nested: ReadonlyArray<NestedProjection>): Projection
  (nested: ReadonlyArray<NestedProjection>): (root: Projection) => Projection
} = Function.dual(2, (root: Projection, nested: ReadonlyArray<NestedProjection>): Projection => {
  const rootTurnId = root.units.find((candidate) => candidate.parentId === undefined)?.turnId ?? root.units[0]?.turnId
  const rootOutcome = root.units.find(
    (candidate) => candidate.parentId === undefined && candidate.executionOutcome !== undefined,
  )?.executionOutcome
  const units = root.units.filter((candidate) => candidate.parentId === undefined && candidate.turnId === rootTurnId)
  for (const { parentId, projection } of nested) {
    const parent = toolUnitById(units, parentId)
    if (parent === undefined) throw new Error(`Nested transcript parent ${parentId} does not exist`)
    const settled =
      rootOutcome?.status === "cancelled" || rootOutcome?.status === "failed"
        ? settleRunning(projection, rootOutcome.status, root.revision)
        : projection
    for (const candidate of settled.units) units.push(attachUnit(candidate, parent, parentId, candidate.turnId))
  }
  units.sort((left, right) => compareUnitOrder(left.order, right.order))
  return { ...root, units }
})
