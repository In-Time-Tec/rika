import type { Entry, PageCursor } from "@rika/product/transcript-page"
import type { ThreadId } from "@rika/product/thread-record"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { RepositoryError, type Interface } from "@rika/product/transcript-repository"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Effect, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import { decode } from "../turn/turn-row-codec"

const UnitJson = Schema.fromJsonString(TranscriptUnit.Unit)
const StateJson = Schema.fromJsonString(ExecutionProjection.ProjectionState)
const error = (cause: unknown) =>
  Schema.is(RepositoryError)(cause) ? cause : RepositoryError.make({ message: String(cause) })
const compareText = (left: string, right: string) => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
const compare = (left: PageCursor, right: PageCursor) =>
  left.createdAt - right.createdAt ||
  compareText(String(left.turnId), String(right.turnId)) ||
  compareText(left.orderKey, right.orderKey)

export const makeTranscriptSqlitePage = (sql: SqlClient): Pick<Interface, "page" | "usage"> => {
  const usage = Effect.fn("TranscriptRepository.usage")(function* (threadId: ThreadId) {
    const rows = yield* sql`SELECT c.state_json, t.*
      FROM rika_transcript_checkpoints c
      JOIN rika_turns t ON t.id = c.turn_id
      WHERE c.thread_id = ${threadId} AND t.status <> 'queued'
        AND c.projection_version = ${ExecutionProjection.projectionVersion}
      ORDER BY t.created_at ASC, t.id ASC`
    const values = yield* Effect.forEach(rows, (raw) =>
      Effect.gen(function* () {
        const row = raw as Record<string, unknown>
        return {
          turn: yield* decode(row),
          state: yield* Schema.decodeUnknownEffect(StateJson)(row.state_json),
        }
      }),
    )
    const contextValue = values.toReversed().find((value) => value.state.usage.context !== undefined)
    return {
      usage: ExecutionProjection.aggregateUsage(values.map((value) => value.state.usage)),
      ...(contextValue?.turn._tag !== "AgentExecution"
        ? {}
        : {
            contextCapacity: {
              contextWindow: contextValue.turn.executionRoute.main.compaction.contextWindow,
              reserveTokens: contextValue.turn.executionRoute.main.compaction.reserveTokens,
            },
          }),
    }
  }, Effect.mapError(error))
  return {
    page: Effect.fn("TranscriptRepository.page")(function* (threadId, options = {}) {
      if (options.before !== undefined && options.after !== undefined)
        return yield* RepositoryError.make({ message: "Transcript page cannot use before and after together" })
      const limit = options.limit ?? 200
      if (!Number.isInteger(limit) || limit < 1 || limit > 500)
        return yield* RepositoryError.make({ message: "Transcript page limit must be from 1 to 500" })
      const rows = yield* (options.projectionVersion === undefined
        ? sql`SELECT u.unit_json, u.unit_order_key,
            c.revision AS projection_revision, c.projection_version, c.state_json, t.*
          FROM rika_transcript_units u
          JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id
          JOIN rika_turns t ON t.id = u.turn_id
          WHERE u.thread_id = ${threadId} AND t.status <> 'queued'
          ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_order_key DESC`
        : sql`SELECT u.unit_json, u.unit_order_key,
            c.revision AS projection_revision, c.projection_version, c.state_json, t.*
          FROM rika_transcript_units u
          JOIN rika_transcript_checkpoints c ON c.turn_id = u.turn_id
          JOIN rika_turns t ON t.id = u.turn_id
          WHERE u.thread_id = ${threadId} AND t.status <> 'queued'
            AND c.projection_version = ${options.projectionVersion}
          ORDER BY u.created_at DESC, u.turn_id DESC, u.unit_order_key DESC`).pipe(Effect.mapError(error))
      const decoded = yield* Effect.forEach(rows, (raw) =>
        Effect.gen(function* () {
          const row = raw as Record<string, unknown>
          const turn = yield* decode(row).pipe(Effect.mapError(error))
          const unit = yield* Schema.decodeUnknownEffect(UnitJson)(row.unit_json).pipe(Effect.mapError(error))
          const cursor = { createdAt: turn.createdAt, turnId: turn.id, orderKey: String(row.unit_order_key) }
          if (unit.turnId !== turn.id || TranscriptOrdering.encodeUnitOrder(unit.order) !== cursor.orderKey)
            return yield* RepositoryError.make({
              message: `Transcript unit ${unit.key} does not match its durable identity`,
            })
          const projectionState = yield* Schema.decodeUnknownEffect(StateJson)(row.state_json).pipe(
            Effect.mapError(error),
          )
          return { turn, unit, cursor, revision: Number(row.projection_revision), projectionState }
        }),
      )
      const ordered = decoded.toSorted((left, right) => compare(left.cursor, right.cursor))
      const boundaryIndex = (predicate: (cursor: PageCursor) => boolean) => {
        const index = ordered.findIndex(({ cursor }) => predicate(cursor))
        return index < 0 ? ordered.length : index
      }
      const afterStart =
        options.after === undefined ? undefined : boundaryIndex((cursor) => compare(cursor, options.after!) > 0)
      let end: number
      if (afterStart !== undefined) end = Math.min(ordered.length, afterStart + limit)
      else if (options.before === undefined) end = ordered.length
      else end = boundaryIndex((cursor) => compare(cursor, options.before!) >= 0)
      const start = afterStart ?? Math.max(0, end - limit)
      const selected = ordered.slice(start, end)
      const entries: ReadonlyArray<Entry> = selected.map(({ turn, unit, revision, projectionState }) => ({
        turn,
        unit,
        projectionRevision: revision,
        projectionModelPhase: -1,
        projectionState,
      }))
      return {
        entries,
        hasOlder: start > 0,
        hasNewer: end < ordered.length,
        oldestCursor: selected[0]?.cursor,
        newestCursor: selected.at(-1)?.cursor,
        usage: yield* usage(threadId),
      }
    }),
    usage,
  }
}
