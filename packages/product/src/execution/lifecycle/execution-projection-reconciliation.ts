export interface ProjectionRevision {
  readonly persisted: number
  readonly incoming: number
}

export const needsProjectionReconciliation = ({ persisted, incoming }: ProjectionRevision): boolean =>
  incoming !== persisted
