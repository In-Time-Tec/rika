import { Service } from "@rika/product/thread-summary-repository"
export { Service }
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { ThreadId } from "@rika/product/thread-record"
import { EditTotals, RepairCandidate, ThreadSummary } from "@rika/product/thread-summary"
import { TurnId } from "@rika/product/turn-record"
import { Status } from "@rika/product/execution-status"
import * as ThreadState from "@rika/product/thread-state"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("ThreadSummaryRepositoryError", {
  message: Schema.String,
}) {}

export interface ListInput {
  readonly includeArchived?: boolean
  readonly limit?: number
}

export interface TurnActivityInput {
  readonly turnId: TurnId
  readonly threadId: ThreadId
  readonly projectedCursor?: string
  readonly complete: boolean
  readonly editTotals: EditTotals
  readonly lastEventAt?: number
  readonly now: number
}

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<ThreadSummary>, RepositoryError>
  readonly ensureTurn: (turnId: TurnId, threadId: ThreadId, now: number) => Effect.Effect<void, RepositoryError>
  readonly replaceTurn: (input: TurnActivityInput) => Effect.Effect<void, RepositoryError>
  readonly markRead: (threadId: ThreadId, now: number) => Effect.Effect<void, RepositoryError>
  readonly listRepairCandidates: (limit?: number) => Effect.Effect<ReadonlyArray<RepairCandidate>, RepositoryError>
}

import { ThreadSummaryRow as SummaryRow } from "./thread-summary-row-codec"

const RepairRow = Schema.Struct({
  turn_id: Schema.String,
  thread_id: Schema.String,
  status: Schema.String,
})

const repositoryError = (error: unknown) => RepositoryError.make({ message: String(error) })
const listLimit = (value: number | undefined) => Math.min(Math.max(value ?? 100, 1), 100)

const decodeSummary = (row: unknown) =>
  Schema.decodeUnknownEffect(SummaryRow)(row).pipe(
    Effect.flatMap((value) =>
      Effect.gen(function* () {
        const editTotals =
          value.turn_count > 0 && value.turn_count === value.current_activity_count
            ? {
                added: Math.max(0, value.added),
                modified: Math.max(0, value.modified),
                removed: Math.max(0, value.removed),
              }
            : undefined
        const id = yield* Schema.decodeUnknownEffect(ThreadId)(value.id)
        return {
          id,
          workspace: value.workspace,
          title: value.title,
          pinned: value.pinned === 1,
          archived: value.archived === 1,
          status: ThreadState.threadStateFromRank({
            rank: value.status_rank,
            lastStatus: value.last_status ?? undefined,
          }),
          unread: value.last_activity_at > (value.last_read_at ?? 0),
          lastActivityAt: value.last_activity_at,
          ...(editTotals === undefined ? {} : { editTotals }),
        } satisfies ThreadSummary
      }),
    ),
    Effect.mapError(repositoryError),
  )

const decodeRepair = (row: unknown) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(RepairRow)(row)
    const status = yield* Schema.decodeUnknownEffect(Status)(value.status)
    const turnId = yield* Schema.decodeUnknownEffect(TurnId)(value.turn_id)
    const threadId = yield* Schema.decodeUnknownEffect(ThreadId)(value.thread_id)
    return RepairCandidate.make({
      turnId,
      threadId,
      status,
    })
  }).pipe(Effect.mapError(repositoryError))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    return Service.of({
      list: Effect.fn("ThreadSummaryRepository.list")(function* (input: ListInput = {}) {
        const rows = yield* sql`SELECT
          summary.thread_id AS id,
          summary.workspace,
          summary.title,
          summary.pinned,
          summary.archived,
          summary.status_rank,
          summary.last_status,
          summary.last_activity_at,
          read_state.last_read_at,
          summary.turn_count,
          summary.current_activity_count,
          summary.added,
          summary.modified,
          summary.removed
        FROM rika_thread_picker_summary AS summary
        LEFT JOIN rika_thread_read_state AS read_state ON read_state.thread_id = summary.thread_id
        WHERE NOT EXISTS (
          SELECT 1 FROM rika_thread_deletion_outbox AS deletion WHERE deletion.thread_id = summary.thread_id
        ) AND (${input.includeArchived === true ? 1 : 0} = 1 OR summary.archived = 0)
        ORDER BY summary.pinned DESC, summary.last_activity_at DESC, summary.thread_id ASC
        LIMIT ${listLimit(input.limit)}`.pipe(Effect.mapError(repositoryError))
        return yield* Effect.all(rows.map(decodeSummary))
      }),
      ensureTurn: Effect.fn("ThreadSummaryRepository.ensureTurn")(function* (turnId, threadId, now) {
        yield* sql`INSERT INTO rika_thread_turn_activity
          (turn_id, thread_id, projected_cursor, complete, added, modified, removed, last_event_at, updated_at)
          VALUES (${turnId}, ${threadId}, NULL, 0, 0, 0, 0, NULL, ${now})
          ON CONFLICT(turn_id) DO NOTHING`.pipe(Effect.mapError(repositoryError))
      }),
      replaceTurn: Effect.fn("ThreadSummaryRepository.replaceTurn")(function* (input) {
        yield* sql`INSERT INTO rika_thread_turn_activity
          (turn_id, thread_id, projected_cursor, complete, added, modified, removed, last_event_at, updated_at)
          VALUES (${input.turnId}, ${input.threadId}, ${input.projectedCursor ?? null}, ${Number(input.complete)},
            ${input.editTotals.added}, ${input.editTotals.modified}, ${input.editTotals.removed},
            ${input.lastEventAt ?? null}, ${input.now})
          ON CONFLICT(turn_id) DO UPDATE SET
            thread_id = excluded.thread_id,
            projected_cursor = excluded.projected_cursor,
            complete = excluded.complete,
            added = excluded.added,
            modified = excluded.modified,
            removed = excluded.removed,
            last_event_at = excluded.last_event_at,
            updated_at = excluded.updated_at
          WHERE excluded.updated_at >= rika_thread_turn_activity.updated_at`.pipe(Effect.mapError(repositoryError))
      }),
      markRead: Effect.fn("ThreadSummaryRepository.markRead")(function* (threadId, now) {
        yield* sql`INSERT INTO rika_thread_read_state (thread_id, last_read_at)
          VALUES (${threadId}, ${now})
          ON CONFLICT(thread_id) DO UPDATE SET
            last_read_at = MAX(rika_thread_read_state.last_read_at, excluded.last_read_at)`.pipe(
          Effect.mapError(repositoryError),
        )
      }),
      listRepairCandidates: Effect.fn("ThreadSummaryRepository.listRepairCandidates")(function* (limit = 25) {
        const rows = yield* sql`SELECT
          turn.id AS turn_id,
          turn.thread_id,
          turn.status
        FROM rika_turns AS turn
        LEFT JOIN rika_thread_turn_activity AS activity ON activity.turn_id = turn.id
        WHERE NOT EXISTS (
          SELECT 1 FROM rika_thread_deletion_outbox AS deletion WHERE deletion.thread_id = turn.thread_id
        ) AND turn.turn_kind = 'AgentExecution' AND (
          activity.turn_id IS NULL
          OR (turn.status IN ('completed', 'failed', 'cancelled') AND activity.complete = 0)
        )
        ORDER BY turn.created_at ASC, turn.rowid ASC
        LIMIT ${listLimit(limit)}`.pipe(Effect.mapError(repositoryError))
        return yield* Effect.all(rows.map(decodeRepair))
      }),
    })
  }),
)

export { makeMemory, memoryLayer } from "./memory-thread-summary-repository"
