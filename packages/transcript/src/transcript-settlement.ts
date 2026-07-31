import { Function } from "effect"
import {
  restoreProjectionFold,
  settleFoldChild,
  settleFoldRunning,
  snapshotFoldProjection,
  type FoldMutation,
} from "./fold"
import type { Projection } from "./schema"

const changed = (mutation: FoldMutation): boolean =>
  mutation.stateChanged || mutation.units.upsert.length > 0 || mutation.units.remove.length > 0

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
