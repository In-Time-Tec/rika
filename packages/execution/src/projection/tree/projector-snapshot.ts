import * as Projection from "@rika/product/execution-projection"
import * as UnitOrder from "@rika/product/execution-transcript-contract"
import type { Unit } from "@rika/product/execution-transcript-contract"
import type { ProjectorCore } from "../persistence"

const snapshot = (
  units: ReadonlyMap<string, Unit>,
  core: ProjectorCore,
  projectionState: () => Projection.ProjectionState,
): Projection.Snapshot => {
  const materialized = [...units.values()].toSorted((left, right) =>
    UnitOrder.compareUnitOrder(left.order, right.order),
  )
  return core.checkpoint === undefined
    ? {
        _tag: "ProjectionSnapshot",
        revision: core.revision,
        units: materialized.slice(-Projection.limits.snapshotUnits),
        hasOlder: core.historyOmitted || materialized.length > Projection.limits.snapshotUnits,
        state: projectionState(),
      }
    : {
        _tag: "ProjectionSnapshot",
        checkpoint: core.checkpoint,
        hasOlder: core.historyOmitted || materialized.length > Projection.limits.snapshotUnits,
        revision: core.revision,
        state: projectionState(),
        units: materialized.slice(-Projection.limits.snapshotUnits),
      }
}

export const ProjectorSnapshot = { snapshot }
