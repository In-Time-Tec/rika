import { Service, RepositoryError } from "@rika/product/transcript-repository"
import type { Interface } from "@rika/product/transcript-repository"
export { Service, RepositoryError } from "@rika/product/transcript-repository"
export type { Interface } from "@rika/product/transcript-repository"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { readTranscriptProjection } from "./transcript-sql-reader"
import { makeTranscriptSqlPage } from "./transcript-sql-page"
import { transcriptSqlWrites } from "./transcript-sql-writes"

const error = (cause: unknown) =>
  Schema.is(RepositoryError)(cause) ? cause : RepositoryError.make({ message: String(cause) })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const get: Interface["get"] = (turnId) => readTranscriptProjection(sql, turnId)
    return Service.of({
      get,
      listProjectionRecoveryCandidates: Effect.fn("TranscriptRepository.listProjectionRecoveryCandidates")(
        function* (projectionVersion) {
          const rows = yield* sql`SELECT t.thread_id, t.id AS turn_id
        FROM rika_turns t
        LEFT JOIN rika_transcript_checkpoints current_checkpoint ON current_checkpoint.turn_id = t.id
        WHERE t.turn_kind = 'AgentExecution'
          AND t.status IN ('running', 'cancelling', 'completed', 'failed', 'cancelled')
          AND t.execution_link_json IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM rika_transcript_checkpoints c
            WHERE c.turn_id = t.id AND c.projection_version > ${projectionVersion}
          )
          AND (
            t.status IN ('running', 'cancelling')
            OR current_checkpoint.turn_id IS NULL
            OR current_checkpoint.state_json::jsonb ->> 'status' <> t.status
          )
        ORDER BY t.created_at ASC, t.id ASC`.pipe(Effect.mapError(error))
          return rows.map((raw) => {
            const row = raw as Record<string, unknown>
            return { threadId: String(row.thread_id) as never, turnId: String(row.turn_id) as never }
          })
        },
      ),
      ...transcriptSqlWrites.make(sql, get),
      ...makeTranscriptSqlPage(sql),
    })
  }),
)
export { makeMemory, memoryLayer, memoryLayerWithTurns } from "./memory-transcript-repository"
