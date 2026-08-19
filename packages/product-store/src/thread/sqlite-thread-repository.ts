import { Service } from "@rika/product/thread-repository"
export { Service }
import { Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Thread, ThreadId, ThreadLineage } from "@rika/product/thread-record"

export class RepositoryError extends Schema.TaggedError<RepositoryError>()("ThreadRepositoryError", {
  message: Schema.String,
}) {}

export interface CreateInput {
  readonly id: ThreadId
  readonly workspace: string
  readonly title: string
  readonly lineage?: ThreadLineage
  readonly now: number
}

interface PendingDeletion {
  readonly threadId: ThreadId
  readonly requestedAt: number
}

export interface ListInput {
  readonly includeArchived?: boolean
  readonly limit?: number
  readonly query?: string
}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Thread, RepositoryError>
  readonly get: (id: ThreadId) => Effect.Effect<Thread | undefined, RepositoryError>
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Thread>, RepositoryError>
  readonly listAll: Effect.Effect<ReadonlyArray<Thread>, RepositoryError>
  readonly rename: (id: ThreadId, title: string, now: number) => Effect.Effect<Thread, RepositoryError>
  readonly renameIfTitle: (
    id: ThreadId,
    expected: string,
    title: string,
    now: number,
  ) => Effect.Effect<Thread | undefined, RepositoryError>
  readonly label: (id: ThreadId, labels: ReadonlyArray<string>, now: number) => Effect.Effect<Thread, RepositoryError>
  readonly setPinned: (id: ThreadId, pinned: boolean, now: number) => Effect.Effect<Thread, RepositoryError>
  readonly setArchived: (id: ThreadId, archived: boolean, now: number) => Effect.Effect<Thread, RepositoryError>
  readonly requestDeletion: (id: ThreadId, requestedAt: number) => Effect.Effect<void, RepositoryError>
  readonly pendingDeletions: Effect.Effect<ReadonlyArray<PendingDeletion>, RepositoryError>
  readonly completeDeletion: (id: ThreadId) => Effect.Effect<void, RepositoryError>
  readonly discard: (id: ThreadId) => Effect.Effect<void, RepositoryError>
}

import { ThreadRow as Row } from "./thread-row-codec"
const LabelsJson = Schema.fromJsonString(Schema.Array(Schema.String))
const LineageJson = Schema.fromJsonString(ThreadLineage)
const repositoryError = (error: unknown) => RepositoryError.make({ message: String(error) })
const listLimit = (value: number | undefined) => Math.min(Math.max(value ?? 50, 1), 100)
const missing = (id: ThreadId) => RepositoryError.make({ message: `Thread ${id} does not exist` })
const clone = (thread: Thread): Thread => structuredClone(thread)
const compare = (left: Thread, right: Thread) =>
  Number(right.pinned) - Number(left.pinned) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id)

const matches = (thread: Thread, query: string | undefined) => {
  if (query === undefined) return true
  const normalized = query.toLowerCase()
  return [thread.title, thread.workspace, ...thread.labels].some((value) => value.toLowerCase().includes(normalized))
}

const select = (threads: ReadonlyArray<Thread>, input: ListInput = {}) =>
  threads
    .filter((thread) => input.includeArchived === true || !thread.archived)
    .filter((thread) => matches(thread, input.query))
    .toSorted(compare)
    .slice(0, listLimit(input.limit))
    .map(clone)

const decode = (row: unknown) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(Row)(row)
    const labels = yield* Schema.decodeUnknownEffect(LabelsJson)(value.labels_json)
    const lineage = yield* Schema.decodeUnknownEffect(LineageJson)(value.lineage_json)
    const id = yield* Schema.decodeUnknownEffect(ThreadId)(value.id)
    return {
      id,
      workspace: value.workspace,
      title: value.title,
      labels,
      pinned: value.pinned === 1,
      archived: value.archived === 1,
      lineage,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }).pipe(Effect.mapError(repositoryError))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const get = Effect.fn("ThreadRepository.get")(function* (id: ThreadId) {
      const rows =
        yield* sql`SELECT * FROM rika_threads WHERE id = ${id} AND NOT EXISTS (SELECT 1 FROM rika_thread_deletion_outbox WHERE thread_id = rika_threads.id)`.pipe(
          Effect.mapError(repositoryError),
        )
      return rows[0] === undefined ? undefined : yield* decode(rows[0])
    })
    const requireThread = Effect.fn("ThreadRepository.requireThread")(function* (id: ThreadId) {
      const thread = yield* get(id)
      if (thread === undefined) return yield* missing(id)
      return thread
    })
    const update = Effect.fn("ThreadRepository.update")(function* (
      id: ThreadId,
      now: number,
      fields: {
        readonly title?: string
        readonly labels?: ReadonlyArray<string>
        readonly pinned?: boolean
        readonly archived?: boolean
      },
    ) {
      yield* requireThread(id)
      yield* sql`UPDATE rika_threads SET
        title = COALESCE(${fields.title ?? null}, title),
        labels_json = COALESCE(${fields.labels === undefined ? null : yield* Schema.encodeEffect(LabelsJson)(fields.labels).pipe(Effect.mapError(repositoryError))}, labels_json),
        pinned = COALESCE(${fields.pinned === undefined ? null : Number(fields.pinned)}, pinned),
        archived = COALESCE(${fields.archived === undefined ? null : Number(fields.archived)}, archived),
        updated_at = ${now}
        WHERE id = ${id}`.pipe(Effect.mapError(repositoryError))
      return yield* requireThread(id)
    })
    return Service.of({
      create: Effect.fn("ThreadRepository.create")(function* (input) {
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO rika_workspaces (path, created_at) VALUES (${input.workspace}, ${input.now}) ON CONFLICT(path) DO NOTHING`.pipe(
                Effect.mapError(repositoryError),
              )
              const lineage = yield* Schema.encodeEffect(LineageJson)(input.lineage ?? { _tag: "Original" }).pipe(
                Effect.mapError(repositoryError),
              )
              yield* sql`INSERT INTO rika_threads (id, workspace, title, labels_json, pinned, archived, lineage_json, created_at, updated_at)
                VALUES (${input.id}, ${input.workspace}, ${input.title}, '[]', 0, 0, ${lineage}, ${input.now}, ${input.now})`.pipe(
                Effect.mapError(repositoryError),
              )
              return yield* requireThread(input.id)
            }),
          )
          .pipe(Effect.mapError(repositoryError))
      }),
      get,
      list: Effect.fn("ThreadRepository.list")(function* (input = {}) {
        const rows = yield* sql`SELECT * FROM rika_threads
          WHERE NOT EXISTS (SELECT 1 FROM rika_thread_deletion_outbox WHERE thread_id = rika_threads.id)
            AND (${input.includeArchived === true ? 1 : 0} = 1 OR archived = 0)
            AND (${input.query === undefined ? 1 : 0} = 1
              OR INSTR(LOWER(title), LOWER(${input.query ?? ""})) > 0
              OR INSTR(LOWER(workspace), LOWER(${input.query ?? ""})) > 0
              OR EXISTS (SELECT 1 FROM json_each(labels_json)
                WHERE INSTR(LOWER(CAST(value AS TEXT)), LOWER(${input.query ?? ""})) > 0))
          ORDER BY pinned DESC, updated_at DESC, id ASC
          LIMIT ${listLimit(input.limit)}`.pipe(Effect.mapError(repositoryError))
        const threads = yield* Effect.all(rows.map(decode))
        return select(threads, input)
      }),
      listAll: Effect.gen(function* () {
        const rows =
          yield* sql`SELECT * FROM rika_threads WHERE NOT EXISTS (SELECT 1 FROM rika_thread_deletion_outbox WHERE thread_id = rika_threads.id)`.pipe(
            Effect.mapError(repositoryError),
          )
        return (yield* Effect.all(rows.map(decode))).toSorted(compare)
      }),
      rename: (id, title, now) => update(id, now, { title }),
      renameIfTitle: Effect.fn("ThreadRepository.renameIfTitle")(function* (id, expected, title, now) {
        const rows = yield* sql`UPDATE rika_threads SET title = ${title}, updated_at = ${now}
          WHERE id = ${id} AND title = ${expected}
            AND NOT EXISTS (SELECT 1 FROM rika_thread_deletion_outbox WHERE thread_id = rika_threads.id)
          RETURNING *`.pipe(Effect.mapError(repositoryError))
        return rows[0] === undefined ? undefined : yield* decode(rows[0])
      }),
      label: (id, labels, now) => update(id, now, { labels: [...new Set(labels)] }),
      setPinned: (id, pinned, now) => update(id, now, { pinned }),
      setArchived: (id, archived, now) => update(id, now, { archived }),
      requestDeletion: Effect.fn("ThreadRepository.requestDeletion")(function* (id, requestedAt) {
        const rows = yield* sql`SELECT id FROM rika_threads WHERE id = ${id}`.pipe(Effect.mapError(repositoryError))
        if (rows[0] === undefined) return yield* missing(id)
        yield* sql`INSERT INTO rika_thread_deletion_outbox (thread_id, requested_at)
          VALUES (${id}, ${requestedAt}) ON CONFLICT (thread_id) DO NOTHING`.pipe(Effect.mapError(repositoryError))
      }),
      pendingDeletions: Effect.gen(function* () {
        const rows = yield* sql<{
          readonly thread_id: string
          readonly requested_at: number
        }>`SELECT thread_id, requested_at
          FROM rika_thread_deletion_outbox ORDER BY requested_at ASC, thread_id ASC`.pipe(
          Effect.mapError(repositoryError),
        )
        return yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(ThreadId)(row.thread_id).pipe(
            Effect.map((threadId) => ({ threadId, requestedAt: Number(row.requested_at) })),
            Effect.mapError(repositoryError),
          ),
        )
      }),
      completeDeletion: Effect.fn("ThreadRepository.completeDeletion")(function* (id) {
        yield* sql
          .withTransaction(sql`DELETE FROM rika_threads WHERE id = ${id}`)
          .pipe(Effect.mapError(repositoryError))
      }),
      discard: Effect.fn("ThreadRepository.discard")(function* (id) {
        const rows = yield* sql`SELECT id FROM rika_threads WHERE id = ${id}`.pipe(Effect.mapError(repositoryError))
        if (rows[0] === undefined) return yield* missing(id)
        yield* sql`DELETE FROM rika_threads WHERE id = ${id}`.pipe(Effect.mapError(repositoryError))
      }),
    })
  }),
)

export { makeMemory, memoryLayer } from "./memory-thread-repository"
