import * as Turn from "@rika/product/turn-record"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as TurnContract from "@rika/product/turn-repository"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { unitOrder } from "@rika/transcript/transcript-unit-order"
import { Effect, Function, Stream } from "effect"

const projectionSnapshotImpl = (
  turnId: string,
  status: ExecutionProjection.ProjectionState["status"],
  cursor: string,
  text?: string,
): ExecutionProjection.Snapshot => ({
  _tag: "ProjectionSnapshot",
  revision: 0,
  checkpoint: { version: ExecutionProjection.projectionVersion, cursor, state: "{}" },
  units:
    text === undefined
      ? []
      : [
          {
            key: `assistant:${turnId}`,
            turnId,
            order: unitOrder(`assistant:${turnId}`, 0),
            revision: 0,
            content: { _tag: "Entry", role: "assistant", text },
          },
        ],
  hasOlder: false,
  state: {
    status,
    usage: ExecutionProjection.emptyUsageState(),
    steering: { steeringMessages: 0, followUpMessages: 0 },
  },
})

const projectionPatchImpl = (
  baseRevision: number,
  revision: number,
  status: ExecutionProjection.ProjectionState["status"],
  cursor: string,
): ExecutionProjection.Patch => ({
  _tag: "ProjectionPatch",
  baseRevision,
  revision,
  checkpoint: { version: ExecutionProjection.projectionVersion, cursor, state: "{}" },
  upsert: [],
  remove: [],
  state: {
    status,
    usage: ExecutionProjection.emptyUsageState(),
    steering: { steeringMessages: 0, followUpMessages: 0 },
  },
})

export const backend = ExecutionGateway.Service.of({
  startTurn: (input) =>
    Effect.succeed({ runId: `${input.turnId}-run`, turnId: input.turnId, threadId: input.threadId }),
  cancelTurn: () => Effect.void,
  steerTurn: () => Effect.void,
  approveTurn: () => Effect.void,
  denyTurn: () => Effect.void,
  watchTurn: (link) => Stream.make(projectionSnapshot(link.turnId, "completed", "cursor-b", "answer")),
  inspectTurn: () => Effect.succeed({ status: "completed" }),
})

export const inspectTurnFromTurns = (turns: TurnContract.Interface) => (link: ExecutionGateway.ExecutionLink) =>
  turns.get(Turn.TurnId.make(link.turnId)).pipe(
    Effect.map((turn) => (turn === undefined ? { status: "unavailable" as const } : { status: turn.status })),
    Effect.orElseSucceed(() => ({ status: "unavailable" as const })),
  )

export const projectionSnapshot: {
  (
    arg0: Parameters<typeof projectionSnapshotImpl>[0],
    arg1: Parameters<typeof projectionSnapshotImpl>[1],
    arg2: Parameters<typeof projectionSnapshotImpl>[2],
    arg3?: Parameters<typeof projectionSnapshotImpl>[3],
  ): ReturnType<typeof projectionSnapshotImpl>
  (
    arg1: Parameters<typeof projectionSnapshotImpl>[1],
    arg2: Parameters<typeof projectionSnapshotImpl>[2],
    arg3?: Parameters<typeof projectionSnapshotImpl>[3],
  ): (arg0: Parameters<typeof projectionSnapshotImpl>[0]) => ReturnType<typeof projectionSnapshotImpl>
} = Function.dual((args) => args.length >= 3, projectionSnapshotImpl)

export const projectionPatch: {
  (
    arg0: Parameters<typeof projectionPatchImpl>[0],
    arg1: Parameters<typeof projectionPatchImpl>[1],
    arg2: Parameters<typeof projectionPatchImpl>[2],
    arg3: Parameters<typeof projectionPatchImpl>[3],
  ): ReturnType<typeof projectionPatchImpl>
  (
    arg1: Parameters<typeof projectionPatchImpl>[1],
    arg2: Parameters<typeof projectionPatchImpl>[2],
    arg3: Parameters<typeof projectionPatchImpl>[3],
  ): (arg0: Parameters<typeof projectionPatchImpl>[0]) => ReturnType<typeof projectionPatchImpl>
} = Function.dual(4, projectionPatchImpl)
