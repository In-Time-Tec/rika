import { projectChildUnits, projectRootUnits, projectUnitDelta, projectUnits } from "./terminal-transcript-projection"
import { transcriptUnitId, transcriptUnits } from "./transcript-row"
import { agentResponseState } from "./transcript-agent-response"
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
