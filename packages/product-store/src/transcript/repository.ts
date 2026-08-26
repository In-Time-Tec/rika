import { Service, RepositoryError } from "@rika/product/transcript-repository"
import type { Interface } from "@rika/product/transcript-repository"
export { Service, RepositoryError } from "@rika/product/transcript-repository"
export type { Interface } from "@rika/product/transcript-repository"
import { and, asc, eq, gt, inArray, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Layer, Schema } from "effect"
import { ThreadId } from "@rika/product/thread-record"
import { TurnId } from "@rika/product/turn-record"
import { rikaTranscriptCheckpoints, rikaTurns } from "../database/schema/product"
import { readTranscriptProjection } from "./sql-reader"
import * as TranscriptSqlPage from "./sql-page"
import { transcriptSqlWrites } from "./sql-writes"

const error = (cause: unknown) =>
  Schema.is(RepositoryError)(cause) ? cause : RepositoryError.make({ message: String(cause) })
const RecoveryRow = Schema.Struct({ thread_id: ThreadId, turn_id: TurnId })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* PgDrizzle.makeWithDefaults()
    const get: Interface["get"] = (turnId) => readTranscriptProjection(db, turnId)
    return Service.of({
      get,
      listProjectionRecoveryCandidates: Effect.fn("TranscriptRepository.listProjectionRecoveryCandidates")(
        function* (projectionVersion) {
          const newerCheckpoint = db
            .select({ turnId: rikaTranscriptCheckpoints.turnId })
            .from(rikaTranscriptCheckpoints)
            .where(
              and(
                eq(rikaTranscriptCheckpoints.turnId, rikaTurns.id),
                gt(rikaTranscriptCheckpoints.projectionVersion, projectionVersion),
              ),
            )
          const rows = yield* db
            .select({ thread_id: rikaTurns.threadId, turn_id: rikaTurns.id })
            .from(rikaTurns)
            .leftJoin(rikaTranscriptCheckpoints, eq(rikaTranscriptCheckpoints.turnId, rikaTurns.id))
            .where(
              and(
                eq(rikaTurns.turnKind, "AgentExecution"),
                inArray(rikaTurns.status, ["running", "cancelling", "completed", "failed", "cancelled"]),
                isNotNull(rikaTurns.executionLinkJson),
                notExists(newerCheckpoint),
                or(
                  inArray(rikaTurns.status, ["running", "cancelling"]),
                  isNull(rikaTranscriptCheckpoints.turnId),
                  ne(sql`${rikaTranscriptCheckpoints.stateJson}::jsonb ->> 'status'`, rikaTurns.status),
                ),
              ),
            )
            .orderBy(asc(rikaTurns.createdAt), asc(rikaTurns.id))
            .pipe(Effect.mapError(error))
          return yield* Effect.forEach(rows, (row) =>
            Schema.decodeEffect(RecoveryRow)(row).pipe(
              Effect.map(({ thread_id, turn_id }) => ({ threadId: thread_id, turnId: turn_id })),
              Effect.mapError(error),
            ),
          )
        },
      ),
      ...transcriptSqlWrites.make(db, get),
      ...TranscriptSqlPage.makeTranscriptSqlPage(db),
    })
  }),
)
export { makeMemory, memoryLayer, memoryLayerWithTurns } from "./memory-repository"
