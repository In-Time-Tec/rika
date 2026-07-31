import type { ProjectionOrigin, VisibleState, UnitDelta } from "./execution-projection-contract"

export interface ExecutionProjectionPatch {
  readonly baseRevision: number
  readonly patchRevision: number
  readonly origin: ProjectionOrigin
  readonly state: VisibleState
  readonly delta: UnitDelta
}
