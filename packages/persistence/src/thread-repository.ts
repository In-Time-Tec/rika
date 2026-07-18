import { Context, Effect, Layer, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { Thread, ThreadId } from "./thread-schema"

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("ThreadRepositoryError", {
  message: Schema.String,
}) {}

export interface CreateInput {
  readonly id: ThreadId
  readonly workspace: string
  readonly title: string
  readonly now: number
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
  readonly remove: (id: ThreadId) => Effect.Effect<void, RepositoryError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/thread-repository/Service") {}

const Row = Schema.Struct({
  id: Schema.String,
  workspace: Schema.String,
  title: Schema.String,
  labels_json: Schema.String,
  pinned: Schema.Finite,
  archived: Schema.Finite,
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})

const LabelsJson = Schema.fromJsonString(Schema.Array(Schema.String))
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
    return {
      id: ThreadId.make(value.id),
      workspace: value.workspace,
      title: value.title,
      labels,
      pinned: value.pinned === 1,
      archived: value.archived === 1,
      createdAt: value.created_at,
      updatedAt: value.updated_at,
    }
  }).pipe(Effect.mapError(repositoryError))

export const makeMemory = (initial: ReadonlyArray<Thread> = []) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(new Map(initial.map((thread) => [thread.id, clone(thread)])))
    const requireThread = Effect.fn("ThreadRepository.requireThread")(function* (id: ThreadId) {
      const thread = (yield* Ref.get(state)).get(id)
      if (thread === undefined) return yield* missing(id)
      return thread
    })
    const update = Effect.fn("ThreadRepository.update")(function* (
      id: ThreadId,
      now: number,
      change: (thread: Thread) => Thread,
    ) {
      const thread = yield* requireThread(id)
      const next = change({ ...thread, updatedAt: now })
      yield* Ref.update(state, (threads) => new Map(threads).set(id, next))
      return clone(next)
    })
    return Service.of({
      create: Effect.fn("ThreadRepository.create")(function* (input) {
        const threads = yield* Ref.get(state)
        if (threads.has(input.id)) {
          return yield* RepositoryError.make({ message: `Thread ${input.id} exists` })
        }
        const thread: Thread = {
          id: input.id,
          workspace: input.workspace,
          title: input.title,
          labels: [],
          pinned: false,
          archived: false,
          createdAt: input.now,
          updatedAt: input.now,
        }
        yield* Ref.update(state, (values) => new Map(values).set(thread.id, thread))
        return clone(thread)
      }),
      get: Effect.fn("ThreadRepository.get")(function* (id) {
        const thread = (yield* Ref.get(state)).get(id)
        return thread === undefined ? undefined : clone(thread)
      }),
      list: Effect.fn("ThreadRepository.list")(function* (input = {}) {
        return select([...(yield* Ref.get(state)).values()], input)
      }),
      listAll: Ref.get(state).pipe(Effect.map((threads) => [...threads.values()].toSorted(compare).map(clone))),
      rename: (id, title, now) => update(id, now, (thread) => ({ ...thread, title })),
      renameIfTitle: Effect.fn("ThreadRepository.renameIfTitle")(function* (id, expected, title, now) {
        const result = yield* Ref.modify(state, (threads) => {
          const thread = threads.get(id)
          if (thread === undefined || thread.title !== expected) return [undefined, threads] as const
          const next = { ...thread, title, updatedAt: now }
          return [clone(next), new Map(threads).set(id, next)] as const
        })
        return result
      }),
      label: (id, labels, now) => update(id, now, (thread) => ({ ...thread, labels: [...new Set(labels)] })),
      setPinned: (id, pinned, now) => update(id, now, (thread) => ({ ...thread, pinned })),
      setArchived: (id, archived, now) => update(id, now, (thread) => ({ ...thread, archived })),
      remove: Effect.fn("ThreadRepository.remove")(function* (id) {
        yield* requireThread(id)
        yield* Ref.update(state, (threads) => {
          const next = new Map(threads)
          next.delete(id)
          return next
        })
      }),
    })
  })

export const memoryLayer = (initial: ReadonlyArray<Thread> = []) => Layer.effect(Service, makeMemory(initial))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const get = Effect.fn("ThreadRepository.get")(function* (id: ThreadId) {
      const rows = yield* sql`SELECT * FROM rika_threads WHERE id = ${id}`.pipe(Effect.mapError(repositoryError))
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
        yield* sql`INSERT INTO rika_workspaces (path, created_at) VALUES (${input.workspace}, ${input.now}) ON CONFLICT(path) DO NOTHING`.pipe(
          Effect.mapError(repositoryError),
        )
        yield* sql`INSERT INTO rika_threads (id, workspace, title, labels_json, pinned, archived, created_at, updated_at)
          VALUES (${input.id}, ${input.workspace}, ${input.title}, '[]', 0, 0, ${input.now}, ${input.now})`.pipe(
          Effect.mapError(repositoryError),
        )
        return yield* requireThread(input.id)
      }),
      get,
      list: Effect.fn("ThreadRepository.list")(function* (input = {}) {
        const rows = yield* sql`SELECT * FROM rika_threads`.pipe(Effect.mapError(repositoryError))
        const threads = yield* Effect.all(rows.map(decode))
        return select(threads, input)
      }),
      listAll: Effect.gen(function* () {
        const rows = yield* sql`SELECT * FROM rika_threads`.pipe(Effect.mapError(repositoryError))
        return (yield* Effect.all(rows.map(decode))).toSorted(compare)
      }),
      rename: (id, title, now) => update(id, now, { title }),
      renameIfTitle: Effect.fn("ThreadRepository.renameIfTitle")(function* (id, expected, title, now) {
        const rows = yield* sql`UPDATE rika_threads SET title = ${title}, updated_at = ${now}
          WHERE id = ${id} AND title = ${expected} RETURNING *`.pipe(Effect.mapError(repositoryError))
        return rows[0] === undefined ? undefined : yield* decode(rows[0])
      }),
      label: (id, labels, now) => update(id, now, { labels: [...new Set(labels)] }),
      setPinned: (id, pinned, now) => update(id, now, { pinned }),
      setArchived: (id, archived, now) => update(id, now, { archived }),
      remove: Effect.fn("ThreadRepository.remove")(function* (id) {
        yield* requireThread(id)
        yield* sql`DELETE FROM rika_threads WHERE id = ${id}`.pipe(Effect.mapError(repositoryError))
      }),
    })
  }),
)
