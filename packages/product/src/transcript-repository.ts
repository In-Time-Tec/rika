import { Context, Effect, Layer, Schema } from "effect"
import * as Transcript from "@rika/transcript/transcript-unit"
import { ThreadId } from "@rika/product/thread-record"
import { Turn, TurnId } from "@rika/product/turn-record"
import type { AgentExecutionTurn, RunningRecordedShellTurn, TerminalRecordedShellTurn } from "@rika/product/turn-record"
import { EntrySchema, PageCursor, type Entry } from "@rika/product/transcript-page"

export { EntrySchema, PageCursor }
export type { Entry }

export const ExecutionAttachment = Schema.Struct({
  parentExecutionKey: Schema.String,
  parentUnitKey: Schema.String,
  parentId: Schema.String,
  parentOrderKey: Schema.String,
})
export type ExecutionAttachment = typeof ExecutionAttachment.Type

export const ExecutionCheckpoint = Schema.Struct({
  executionKey: Schema.String,
  executionId: Schema.String,
  cursor: Schema.String,
  sequence: Schema.Finite,
  status: Schema.optionalKey(Schema.Literals(["completed", "failed", "cancelled"])),
  state: Transcript.ProjectionState,
  attachment: Schema.optionalKey(ExecutionAttachment),
})
export type ExecutionCheckpoint = typeof ExecutionCheckpoint.Type

export const invalidatedProjectionVersion = 2

export interface Projection {
  readonly turn: Turn
  readonly units: ReadonlyArray<Transcript.Unit>
  readonly checkpointGeneration: number
  readonly revision: number
  readonly modelPhase: number
  readonly usableCompletionSequence: number | undefined
  readonly oldestCursor: string | undefined
  readonly checkpointCursor: string | undefined
  readonly costUsd: number | undefined
  readonly usageCursors: ReadonlyArray<string> | undefined
  readonly pricingVersion: string | undefined
  readonly executionCheckpoints: ReadonlyArray<ExecutionCheckpoint>
  readonly projectionVersion: number
}

export interface CheckpointOptions {
  readonly executionCheckpoints: ReadonlyArray<ExecutionCheckpoint>
  readonly projectionVersion: number
}

export interface DeltaCheckpointOptions extends CheckpointOptions {
  readonly expectedGeneration: number | undefined
}

export interface UnitDelta {
  readonly upsert: ReadonlyArray<Transcript.Unit>
  readonly remove: ReadonlyArray<string>
}

export interface RefoldOptions extends CheckpointOptions {
  readonly expectedProjectionVersion: number
  readonly expectedGeneration: number
}

export interface PageOptions {
  readonly before?: PageCursor | undefined
  readonly after?: PageCursor | undefined
  readonly limit?: number
  readonly projectionVersion?: number
}

export interface Page {
  readonly entries: ReadonlyArray<Entry>
  readonly hasOlder: boolean
  readonly hasNewer?: boolean
  readonly oldestCursor: PageCursor | undefined
  readonly newestCursor?: PageCursor | undefined
  readonly threadCostUsd: number
}

export interface ProjectionRecoveryCandidate {
  readonly threadId: ThreadId
  readonly turnId: TurnId
}

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("TranscriptRepositoryError", {
  message: Schema.String,
}) {}

export type WriteResult = "committed" | "stale"
export type RefoldWriteResult =
  | { readonly _tag: "Committed"; readonly turn: AgentExecutionTurn }
  | { readonly _tag: "Stale" }
export type RecordedShellWriteResult =
  | { readonly _tag: "Committed"; readonly projection: Projection }
  | { readonly _tag: "Stale" }

export interface Interface {
  readonly get: (turnId: TurnId) => Effect.Effect<Projection | undefined, RepositoryError>
  readonly listProjectionRecoveryCandidates: (
    projectionVersion: number,
  ) => Effect.Effect<ReadonlyArray<ProjectionRecoveryCandidate>, RepositoryError>
  readonly commitDelta: (
    turn: AgentExecutionTurn,
    state: Transcript.ProjectionState,
    delta: UnitDelta,
    options: DeltaCheckpointOptions,
  ) => Effect.Effect<WriteResult, RepositoryError>
  readonly replaceForRefold: (
    turn: AgentExecutionTurn,
    projection: Transcript.Projection,
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

export class Service extends Context.Service<Service, Interface>()("@rika/product/transcript-repository/Service") {}

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
