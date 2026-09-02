import * as Projection from "@rika/product/execution-projection"

export interface AuthorizationState {
  readonly unitKey: string
  readonly rawRunId: string
  readonly authorizationId: string
  readonly approvalId: string
}

export interface ProjectorCore {
  revision: number
  checkpoint: Projection.Checkpoint | undefined
  historyOmitted: boolean
  rootStatus: Projection.ProjectionState["status"]
  title: Projection.GeneratedTitle | undefined
  steeringMessages: number
  followUpMessages: number
}
