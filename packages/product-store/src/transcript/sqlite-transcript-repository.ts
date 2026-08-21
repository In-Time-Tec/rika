import { Service, RepositoryError } from "@rika/product/transcript-repository"
import type { Interface } from "@rika/product/transcript-repository"
export { Service, RepositoryError } from "@rika/product/transcript-repository"
export type { Interface } from "@rika/product/transcript-repository"
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { readTranscriptProjection } from "./transcript-sqlite-reader"
import { makeTranscriptSqlitePage } from "./transcript-sqlite-page"
import { transcriptSqliteWrites } from "./transcript-sqlite-writes"

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
        LEFT JOIN rika_transcript_checkpoints c ON c.turn_id = t.id
        WHERE t.turn_kind = 'AgentExecution' AND t.status NOT IN ('queued', 'completed', 'failed', 'cancelled')
          AND (c.turn_id IS NULL OR c.projection_version <> ${projectionVersion} OR c.projector_version IS NULL)
        ORDER BY t.created_at ASC, t.id ASC`.pipe(Effect.mapError(error))
          return rows.map((raw) => {
            const row = raw as Record<string, unknown>
            return { threadId: String(row.thread_id) as never, turnId: String(row.turn_id) as never }
          })
        },
      ),
      ...transcriptSqliteWrites.make(sql, get),
      ...makeTranscriptSqlitePage(sql),
    })
  }),
)
export { makeMemory, memoryLayer, memoryLayerWithTurns } from "./memory-transcript-repository"
