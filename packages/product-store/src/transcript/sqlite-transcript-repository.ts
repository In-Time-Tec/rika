import { Service, RepositoryError, invalidatedProjectionVersion } from "@rika/product/transcript-repository"
export {
  Service,
  RepositoryError,
  invalidatedProjectionVersion,
  PageCursor,
  ExecutionCheckpoint,
  EntrySchema,
} from "@rika/product/transcript-repository"
export type {
  Interface,
  Entry,
  Projection,
  Page,
  CheckpointOptions,
  DeltaCheckpointOptions,
  UnitDelta,
  RefoldOptions,
  PageOptions,
  ProjectionRecoveryCandidate,
  WriteResult,
  RefoldWriteResult,
  RecordedShellWriteResult,
} from "@rika/product/transcript-repository"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { TurnId } from "@rika/product/turn-record"
import { support } from "./transcript-repository-support"
import { readTranscriptProjection } from "./transcript-sqlite-reader"
import { makeTranscriptSqliteCheckpoints } from "./transcript-sqlite-checkpoints"
import { makeTranscriptSqlitePage } from "./transcript-sqlite-page"
import { transcriptSqliteWrites } from "./transcript-sqlite-writes"

const { error, validateCurrentProjectionVersion } = support

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const checkpoints = makeTranscriptSqliteCheckpoints(sql)
    const get = Effect.fn("TranscriptRepository.get")((turnId: TurnId) =>
      readTranscriptProjection(sql, turnId, checkpoints.loadExecutionCheckpoints),
    )
    const listProjectionRecoveryCandidates = Effect.fn("TranscriptRepository.listProjectionRecoveryCandidates")(
      function* (projectionVersion: number) {
        yield* validateCurrentProjectionVersion(projectionVersion)
        const rows = yield* sql`
          SELECT t.thread_id, t.id AS turn_id
          FROM rika_turns t
          LEFT JOIN rika_transcript_checkpoints c ON c.turn_id = t.id
          WHERE t.turn_kind = 'AgentExecution'
            AND t.status <> 'queued'
            AND (
              c.turn_id IS NULL
              OR c.projection_version < ${projectionVersion}
              OR EXISTS (
                SELECT 1
                FROM rika_transcript_execution_checkpoints e
                WHERE e.turn_id = t.id AND e.status IS NULL
              )
            )
          ORDER BY t.created_at ASC, t.rowid ASC
        `.pipe(Effect.mapError(error))
        return yield* Effect.all(
          rows.map((row) =>
            Schema.decodeUnknownEffect(support.ProjectionRecoveryCandidateRow)(row).pipe(
              Effect.map((candidate) => ({ threadId: candidate.thread_id, turnId: candidate.turn_id })),
              Effect.mapError(error),
            ),
          ),
        )
      },
    )
    return Service.of({
      get,
      listProjectionRecoveryCandidates,
      ...transcriptSqliteWrites.make(sql, checkpoints, get),
      ...makeTranscriptSqlitePage(sql),
    })
  }),
)
export { makeMemory, memoryLayer, memoryLayerWithTurns } from "./memory-transcript-repository"
