import { Context, Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as ThreadRepository from "./thread-repository"
import { ThreadId } from "./thread-schema"
import { EditTotals, RepairCandidate, SummaryStatus, ThreadSummary } from "./thread-summary-schema"
import * as TurnRepository from "./turn-repository"
import { Status, TurnId } from "./turn-schema"

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

export class Service extends Context.Service<Service, Interface>()(
  "@rika/persistence/thread-summary-repository/Service",
) {}

interface Activity {
  readonly turnId: TurnId
  readonly threadId: ThreadId
  readonly projectedCursor?: string
  readonly complete: boolean
  readonly editTotals: EditTotals
  readonly lastEventAt?: number
  readonly updatedAt: number
}

const SummaryRow = Schema.Struct({
  id: Schema.String,
  workspace: Schema.String,
  title: Schema.String,
  pinned: Schema.Finite,
  archived: Schema.Finite,
  status_rank: Schema.Finite,
  last_activity_at: Schema.Finite,
  last_read_at: Schema.NullOr(Schema.Finite),
  turn_count: Schema.Finite,
  activity_count: Schema.Finite,
  added: Schema.Finite,
  modified: Schema.Finite,
  removed: Schema.Finite,
})

const RepairRow = Schema.Struct({
  turn_id: Schema.String,
  thread_id: Schema.String,
  status: Schema.String,
  last_cursor: Schema.NullOr(Schema.String),
})

const repositoryError = (error: unknown) => RepositoryError.make({ message: String(error) })
const listLimit = (value: number | undefined) => Math.min(Math.max(value ?? 100, 1), 100)
const statusRank = (status: Status): number =>
  status === "accepted" || status === "running" ? 3 : status === "waiting" ? 2 : status === "queued" ? 1 : 0
const summaryStatus = (rank: number): SummaryStatus =>
  rank >= 3 ? "running" : rank === 2 ? "waiting" : rank === 1 ? "queued" : "idle"

const decodeSummary = (row: unknown) =>
  Schema.decodeUnknownEffect(SummaryRow)(row).pipe(
    Effect.map((value): ThreadSummary => {
      const editTotals =
        value.turn_count > 0 && value.turn_count === value.activity_count
          ? {
              added: Math.max(0, value.added),
              modified: Math.max(0, value.modified),
              removed: Math.max(0, value.removed),
            }
          : undefined
      return {
        id: ThreadId.make(value.id),
        workspace: value.workspace,
        title: value.title,
        pinned: value.pinned === 1,
        archived: value.archived === 1,
        status: summaryStatus(value.status_rank),
        unread: value.last_activity_at > (value.last_read_at ?? 0),
        lastActivityAt: value.last_activity_at,
        ...(editTotals === undefined ? {} : { editTotals }),
      }
    }),
    Effect.mapError(repositoryError),
  )

const decodeRepair = (row: unknown) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(RepairRow)(row)
    const status = yield* Schema.decodeUnknownEffect(Status)(value.status)
    return RepairCandidate.make({
      turnId: TurnId.make(value.turn_id),
      threadId: ThreadId.make(value.thread_id),
      status,
      ...(value.last_cursor === null ? {} : { lastCursor: value.last_cursor }),
    })
  }).pipe(Effect.mapError(repositoryError))

const compareSummaries = (left: ThreadSummary, right: ThreadSummary) =>
  Number(right.pinned) - Number(left.pinned) ||
  right.lastActivityAt - left.lastActivityAt ||
  left.id.localeCompare(right.id)

export const makeMemory = Effect.fn("ThreadSummaryRepository.makeMemory")(function* () {
  const threads = yield* ThreadRepository.Service
  const turns = yield* TurnRepository.Service
  const activities = yield* Ref.make(new Map<TurnId, Activity>())
  const readAt = yield* Ref.make(new Map<ThreadId, number>())

  const list = Effect.fn("ThreadSummaryRepository.list")(function* (input: ListInput = {}) {
    const threadValues = yield* threads
      .list({ includeArchived: true, limit: 100 })
      .pipe(Effect.mapError(repositoryError))
    const activityValues = yield* Ref.get(activities)
    const readValues = yield* Ref.get(readAt)
    const summaries = yield* Effect.forEach(threadValues, (thread) =>
      Effect.gen(function* () {
        const history = yield* turns.list(thread.id).pipe(Effect.mapError(repositoryError))
        const projected = history.flatMap((turn) => {
          const activity = activityValues.get(turn.id)
          return activity === undefined ? [] : [activity]
        })
        const rank = history.reduce((maximum, turn) => Math.max(maximum, statusRank(turn.status)), 0)
        const lastActivityAt = Math.max(
          thread.updatedAt,
          ...history.map((turn) => turn.updatedAt),
          ...projected.map((activity) => activity.lastEventAt ?? activity.updatedAt),
        )
        const totals = projected.reduce(
          (total, activity) => ({
            added: total.added + activity.editTotals.added,
            modified: total.modified + activity.editTotals.modified,
            removed: total.removed + activity.editTotals.removed,
          }),
          { added: 0, modified: 0, removed: 0 },
        )
        return ThreadSummary.make({
          id: thread.id,
          workspace: thread.workspace,
          title: thread.title,
          pinned: thread.pinned,
          archived: thread.archived,
          status: summaryStatus(rank),
          unread: lastActivityAt > (readValues.get(thread.id) ?? 0),
          lastActivityAt,
          ...(history.length > 0 && projected.length === history.length ? { editTotals: totals } : {}),
        })
      }),
    )
    return summaries
      .filter((summary) => input.includeArchived === true || !summary.archived)
      .toSorted(compareSummaries)
      .slice(0, listLimit(input.limit))
  })

  return Service.of({
    list,
    ensureTurn: Effect.fn("ThreadSummaryRepository.ensureTurn")(function* (turnId, threadId, now) {
      yield* Ref.update(activities, (current) =>
        current.has(turnId)
          ? current
          : new Map(current).set(turnId, {
              turnId,
              threadId,
              complete: false,
              editTotals: { added: 0, modified: 0, removed: 0 },
              updatedAt: now,
            }),
      )
    }),
    replaceTurn: Effect.fn("ThreadSummaryRepository.replaceTurn")(function* (input) {
      yield* Ref.update(activities, (current) =>
        new Map(current).set(input.turnId, {
          turnId: input.turnId,
          threadId: input.threadId,
          ...(input.projectedCursor === undefined ? {} : { projectedCursor: input.projectedCursor }),
          complete: input.complete,
          editTotals: structuredClone(input.editTotals),
          ...(input.lastEventAt === undefined ? {} : { lastEventAt: input.lastEventAt }),
          updatedAt: input.now,
        }),
      )
    }),
    markRead: Effect.fn("ThreadSummaryRepository.markRead")(function* (threadId, now) {
      yield* Ref.update(readAt, (current) => new Map(current).set(threadId, now))
    }),
    listRepairCandidates: Effect.fn("ThreadSummaryRepository.listRepairCandidates")(function* (limit = 25) {
      const activityValues = yield* Ref.get(activities)
      const threadValues = yield* threads
        .list({ includeArchived: true, limit: 100 })
        .pipe(Effect.mapError(repositoryError))
      const history = (yield* Effect.forEach(threadValues, (thread) =>
        turns.list(thread.id).pipe(Effect.mapError(repositoryError)),
      )).flat()
      return history
        .filter((turn) => {
          const activity = activityValues.get(turn.id)
          return (
            activity === undefined ||
            activity.projectedCursor !== turn.lastCursor ||
            (["completed", "failed", "cancelled"].includes(turn.status) && !activity.complete)
          )
        })
        .slice(0, listLimit(limit))
        .map((turn) =>
          RepairCandidate.make({
            turnId: turn.id,
            threadId: turn.threadId,
            status: turn.status,
            ...(turn.lastCursor === undefined ? {} : { lastCursor: turn.lastCursor }),
          }),
        )
    }),
  })
})

export const memoryLayer = Layer.effect(Service, makeMemory())

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    return Service.of({
      list: Effect.fn("ThreadSummaryRepository.list")(function* (input: ListInput = {}) {
        const rows = yield* sql`SELECT
          thread.id,
          thread.workspace,
          thread.title,
          thread.pinned,
          thread.archived,
          MAX(CASE
            WHEN turn.status IN ('accepted', 'running') THEN 3
            WHEN turn.status = 'waiting' THEN 2
            WHEN turn.status = 'queued' THEN 1
            ELSE 0
          END) AS status_rank,
          MAX(
            thread.updated_at,
            COALESCE(MAX(turn.updated_at), thread.updated_at),
            COALESCE(MAX(activity.last_event_at), thread.updated_at)
          ) AS last_activity_at,
          read_state.last_read_at,
          COUNT(turn.id) AS turn_count,
          COUNT(activity.turn_id) AS activity_count,
          COALESCE(SUM(activity.added), 0) AS added,
          COALESCE(SUM(activity.modified), 0) AS modified,
          COALESCE(SUM(activity.removed), 0) AS removed
        FROM rika_threads AS thread
        LEFT JOIN rika_turns AS turn ON turn.thread_id = thread.id
        LEFT JOIN rika_thread_turn_activity AS activity ON activity.turn_id = turn.id
        LEFT JOIN rika_thread_read_state AS read_state ON read_state.thread_id = thread.id
        WHERE (${input.includeArchived === true ? 1 : 0} = 1 OR thread.archived = 0)
        GROUP BY thread.id
        ORDER BY thread.pinned DESC, last_activity_at DESC, thread.id ASC
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
            updated_at = excluded.updated_at`.pipe(Effect.mapError(repositoryError))
      }),
      markRead: Effect.fn("ThreadSummaryRepository.markRead")(function* (threadId, now) {
        yield* sql`INSERT INTO rika_thread_read_state (thread_id, last_read_at)
          VALUES (${threadId}, ${now})
          ON CONFLICT(thread_id) DO UPDATE SET last_read_at = excluded.last_read_at`.pipe(
          Effect.mapError(repositoryError),
        )
      }),
      listRepairCandidates: Effect.fn("ThreadSummaryRepository.listRepairCandidates")(function* (limit = 25) {
        const rows = yield* sql`SELECT
          turn.id AS turn_id,
          turn.thread_id,
          turn.status,
          turn.last_cursor
        FROM rika_turns AS turn
        LEFT JOIN rika_thread_turn_activity AS activity ON activity.turn_id = turn.id
        WHERE activity.turn_id IS NULL
          OR COALESCE(activity.projected_cursor, '') <> COALESCE(turn.last_cursor, '')
          OR (turn.status IN ('completed', 'failed', 'cancelled') AND activity.complete = 0)
        ORDER BY turn.created_at ASC, turn.rowid ASC
        LIMIT ${listLimit(limit)}`.pipe(Effect.mapError(repositoryError))
        return yield* Effect.all(rows.map(decodeRepair))
      }),
    })
  }),
)
