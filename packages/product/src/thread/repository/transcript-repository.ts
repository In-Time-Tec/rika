import { Context, Effect, Layer, Schema } from "effect"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { ThreadId } from "@rika/product/thread-record"
import { Turn, TurnId } from "@rika/product/turn-record"
import type { AgentExecutionTurn } from "@rika/product/turn-record"
import type { RunningRecordedShellTurn, TerminalRecordedShellTurn } from "@rika/product/thread-result"
import type {
  ExecutionCheckpoint,
  Page,
  PageCursor,
  Projection,
  RefoldWriteResult,
} from "@rika/product/transcript-page"

interface CheckpointOptions {
  readonly executionCheckpoints: ReadonlyArray<ExecutionCheckpoint>
  readonly projectionVersion: number
}

interface DeltaCheckpointOptions extends CheckpointOptions {
  readonly expectedGeneration: number | undefined
}

interface UnitDelta {
  readonly upsert: ReadonlyArray<TranscriptUnit.Unit>
  readonly remove: ReadonlyArray<string>
}

interface RefoldOptions extends CheckpointOptions {
  readonly expectedProjectionVersion: number
  readonly expectedGeneration: number
}

interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly after?: PageCursor | undefined
  readonly limit?: number
  readonly projectionVersion?: number
}

interface ProjectionRecoveryCandidate {
  readonly threadId: ThreadId
  readonly turnId: TurnId
}

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("TranscriptRepositoryError", {
  message: Schema.String,
}) {}

type WriteResult = "committed" | "stale"
type RecordedShellWriteResult =
  | { readonly _tag: "Committed"; readonly projection: Projection }
  | { readonly _tag: "Stale" }

export interface Interface {
  readonly get: (turnId: TurnId) => Effect.Effect<Projection | undefined, RepositoryError>
  readonly listProjectionRecoveryCandidates: (
    projectionVersion: number,
  ) => Effect.Effect<ReadonlyArray<ProjectionRecoveryCandidate>, RepositoryError>
  readonly commitDelta: (
    turn: AgentExecutionTurn,
    state: TranscriptProjectionModel.ProjectionState,
    delta: UnitDelta,
    options: DeltaCheckpointOptions,
  ) => Effect.Effect<WriteResult, RepositoryError>
  readonly replaceForRefold: (
    turn: AgentExecutionTurn,
    projection: TranscriptProjectionModel.Projection,
    options: RefoldOptions,
  ) => Effect.Effect<RefoldWriteResult, RepositoryError>
  readonly createRecordedShell: (
    turn: RunningRecordedShellTurn,
    projectionVersion: number,
  ) => Effect.Effect<Projection, RepositoryError>
  readonly copyRecordedShell: (
    turn: TerminalRecordedShellTurn,
    projectionVersion: number,
  ) => Effect.Effect<Projection, RepositoryError>
  readonly settleRecordedShell: (
    expected: RunningRecordedShellTurn,
    turn: TerminalRecordedShellTurn,
    expectedGeneration: number,
    projectionVersion: number,
  ) => Effect.Effect<RecordedShellWriteResult, RepositoryError>
  readonly page: (threadId: ThreadId, options?: PageOptions) => Effect.Effect<Page, RepositoryError>
  readonly globalCostUsd: Effect.Effect<number, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/thread/repository/transcript-repository/Service",
) {}

const emptyProjection = (turn: Turn, projectionVersion: number): Projection => ({
  turn,
  units: [],
  checkpointGeneration: 0,
  revision: 0,
  modelPhase: -1,
  usableCompletionSequence: undefined,
  oldestCursor: undefined,
  checkpointCursor: undefined,
  costUsd: undefined,
  usageCursors: undefined,
  pricingVersion: undefined,
  executionCheckpoints: [],
  projectionVersion,
})

export const memoryLayerWithTurns = Layer.succeed(
  Service,
  Service.of({
    get: (): Effect.Effect<Projection | undefined> => Effect.sync(() => undefined),
    listProjectionRecoveryCandidates: () => Effect.succeed<ReadonlyArray<ProjectionRecoveryCandidate>>([]),
    commitDelta: () => Effect.succeed<WriteResult>("committed"),
    replaceForRefold: (turn: AgentExecutionTurn) => Effect.succeed<RefoldWriteResult>({ _tag: "Committed", turn }),
    createRecordedShell: (turn: RunningRecordedShellTurn, projectionVersion: number) =>
      Effect.succeed(emptyProjection(turn, projectionVersion)),
    copyRecordedShell: (turn: TerminalRecordedShellTurn, projectionVersion: number) =>
      Effect.succeed(emptyProjection(turn, projectionVersion)),
    settleRecordedShell: (
      _expected: RunningRecordedShellTurn,
      turn: TerminalRecordedShellTurn,
      _generation: number,
      projectionVersion: number,
    ) =>
      Effect.succeed<RecordedShellWriteResult>({
        _tag: "Committed",
        projection: emptyProjection(turn, projectionVersion),
      }),
    page: () => Effect.succeed<Page>({ entries: [], hasOlder: false, oldestCursor: undefined, threadCostUsd: 0 }),
    globalCostUsd: Effect.succeed(0),
  }),
)
