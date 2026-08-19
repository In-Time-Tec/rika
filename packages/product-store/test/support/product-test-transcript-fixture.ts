import * as ExecutionProjection from "@rika/product/execution-projection"
import type { AgentExecutionTurn } from "@rika/product/turn-record"
import type { Interface as TranscriptRepository } from "@rika/product/transcript-repository"
import type { Unit } from "@rika/transcript/transcript-unit"
import { Function } from "effect"

const settledStatuses = new Set(["completed", "failed", "cancelled", "waiting"])

const projectionStatus = (status: AgentExecutionTurn["status"]): ExecutionProjection.ProjectionState["status"] =>
  settledStatuses.has(status) ? (status as ExecutionProjection.ProjectionState["status"]) : "running"

const storeProjectionImpl = (
  repository: TranscriptRepository,
  turn: AgentExecutionTurn,
  projection: { readonly units: ReadonlyArray<Unit>; readonly revision: number },
) =>
  repository.commitProjection(turn, {
    _tag: "ProjectionSnapshot",
    revision: projection.revision,
    checkpoint: {
      version: ExecutionProjection.projectionVersion,
      cursor: `fixture:${projection.revision}`,
      state: "{}",
    },
    units: projection.units,
    hasOlder: false,
    state: {
      status: projectionStatus(turn.status),
      usage: ExecutionProjection.emptyUsageState(),
      steering: { steeringMessages: 0, followUpMessages: 0 },
    },
  })

export const storeProjection: {
  (
    arg0: Parameters<typeof storeProjectionImpl>[0],
    arg1: Parameters<typeof storeProjectionImpl>[1],
    arg2: Parameters<typeof storeProjectionImpl>[2],
  ): ReturnType<typeof storeProjectionImpl>
  (
    arg1: Parameters<typeof storeProjectionImpl>[1],
    arg2: Parameters<typeof storeProjectionImpl>[2],
  ): (arg0: Parameters<typeof storeProjectionImpl>[0]) => ReturnType<typeof storeProjectionImpl>
} = Function.dual(3, storeProjectionImpl)
