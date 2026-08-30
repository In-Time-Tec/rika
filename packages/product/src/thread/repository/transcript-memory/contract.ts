import { Context, Effect, Schema } from "effect"
import type { ThreadId } from "@rika/product/thread-record"
import type { AgentExecutionTurn, Turn, TurnId } from "@rika/product/turn-record"
import type { Page, Projection, UsageSummary } from "@rika/product/transcript-page"
import type { Unit } from "@rika/transcript/transcript-unit"
import type * as ExecutionProjection from "../../../execution/projection/contract"
import type { PageOptions, ProjectionRecoveryCandidate } from "../transcript-options"

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("TranscriptRepositoryError", {
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
    withinTransaction?: Effect.Effect<void, RepositoryError>,
  ) => Effect.Effect<WriteResult, RepositoryError>
  readonly replaceUnits: (turn: Turn, units: ReadonlyArray<Unit>) => Effect.Effect<Projection, RepositoryError>
  readonly page: (threadId: ThreadId, options?: PageOptions) => Effect.Effect<Page, RepositoryError>
  readonly usage: (threadId: ThreadId) => Effect.Effect<UsageSummary, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/thread/repository/transcript-memory/contract/Service",
) {}
