import { projectChildUnits, projectRootUnits, projectUnitDelta, projectUnits } from "./projection"
import { transcriptUnitId, transcriptUnits } from "./row"
import { agentResponseState } from "./agent-response"
export const applyChildUnits = projectChildUnits
export const applyRootUnits = projectRootUnits
export const applyTurnDelta = projectUnitDelta
export const applyTurnUnits = projectUnits
export const rows = transcriptUnits
export const unitId = transcriptUnitId
export const responseState = agentResponseState
export type PathTarget = {
  readonly path: string
  readonly line?: number
  readonly column?: number
}
