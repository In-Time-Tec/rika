import { Effect, Layer } from "effect"
import type { Projection } from "@rika/product/transcript-page"
import * as ExecutionProjection from "../../execution/projection/contract"
import { Service } from "./transcript-memory/contract"

export type { ProjectionRecoveryCandidate } from "./transcript-options"
export type { Interface, WriteResult } from "./transcript-memory/contract"
export { RepositoryError, Service } from "./transcript-memory/contract"

export const productMemoryLayerWithTurns = Layer.succeed(
  Service,
  Service.of({
    get: (): Effect.Effect<Projection | undefined> => Effect.as(Effect.void, undefined),
    listProjectionRecoveryCandidates: () => Effect.succeed([]),
    commitProjection: (_turn, _change, withinTransaction) =>
      withinTransaction === undefined ? Effect.succeed("committed") : withinTransaction.pipe(Effect.as("committed")),
    replaceUnits: (turn, units) =>
      Effect.succeed({
        turn,
        units,
        checkpointGeneration: 0,
        revision: 0,
        state: {
          status: turn.status === "queued" || turn.status === "accepted" ? "running" : turn.status,
          usage: {
            ...ExecutionProjection.emptyUsageState(),
            sourceComplete: turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled",
          },
          steering: { steeringMessages: 0, followUpMessages: 0 },
        },
        projectionVersion: ExecutionProjection.projectionVersion,
      }),
    page: () =>
      Effect.succeed({
        entries: [],
        hasOlder: false,
        hasNewer: false,
        oldestCursor: undefined,
        newestCursor: undefined,
        usage: { usage: ExecutionProjection.emptyUsageState() },
      }),
    usage: () => Effect.succeed({ usage: ExecutionProjection.emptyUsageState() }),
  }),
)

export { makeMemory, memoryLayer } from "./transcript-memory/memory"
