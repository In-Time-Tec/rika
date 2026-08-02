import { Function } from "effect"
import { childOrder, compareUnitOrder, localOrder } from "../ordering/transcript-unit-order"
import { settleRunning } from "./transcript-settlement"
import type { Projection } from "../schema/transcript-projection-model"
import type { Unit } from "../schema/transcript-unit"

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
