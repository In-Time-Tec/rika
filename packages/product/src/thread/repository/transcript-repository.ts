import { Context, Effect, Layer, Schema } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import { TurnId } from "@rika/product/turn-record"
import type { AgentExecutionTurn, Turn } from "@rika/product/turn-record"
import type { Page, Projection, UsageSummary } from "@rika/product/transcript-page"
import type { PageOptions, ProjectionRecoveryCandidate } from "./transcript-repository-options"
import type { Unit } from "@rika/transcript/transcript-unit"
import * as ExecutionProjection from "../../execution/contract/execution-projection"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("TranscriptRepositoryError", {
  message: Schema.String,
}) {}
export type WriteResult = "committed" | "stale"

export interface Interface {
  readonly get: (turnId: TurnId) => Effect.Effect<Projection | undefined, RepositoryError>
  readonly listProjectionRecoveryCandidates: (
    projectionVersion: number,
  ) => Effect.Effect<ReadonlyArray<ProjectionRecoveryCandidate>, RepositoryError>
  readonly commitProjection: (
    turn: AgentExecutionTurn,
    change: ExecutionProjection.Change,
  ) => Effect.Effect<WriteResult, RepositoryError>
  readonly replaceUnits: (turn: Turn, units: ReadonlyArray<Unit>) => Effect.Effect<Projection, RepositoryError>
  readonly page: (threadId: ThreadId, options?: PageOptions) => Effect.Effect<Page, RepositoryError>
  readonly usage: (threadId: ThreadId) => Effect.Effect<UsageSummary, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/thread/repository/transcript-repository/Service",
) {}

export const productMemoryLayerWithTurns = Layer.succeed(
  Service,
  Service.of({
    get: (): Effect.Effect<Projection | undefined> => Effect.as(Effect.void, undefined),
    listProjectionRecoveryCandidates: () => Effect.succeed([]),
    commitProjection: () => Effect.succeed("committed"),
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
        projectionVersion: 1,
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
