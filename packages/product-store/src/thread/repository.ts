import { Service } from "@rika/product/thread-repository"
export { Service }
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, asc, desc, eq, ilike, notExists, or } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"
import { Thread, ThreadId, ThreadLineage } from "@rika/product/thread-record"
import {
  rikaThreadDeletionOutbox,
  rikaThreads,
  rikaWorkspaces,
} from "../database/schema/product"

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
  readonly archiveAndCreate: (currentId: ThreadId, input: CreateInput) => Effect.Effect<Thread, RepositoryError>
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

const LabelsJson = Schema.fromJsonString(Schema.Array(Schema.String))
const LineageJson = Schema.fromJsonString(ThreadLineage)
const repositoryError = (error: { readonly message: string }) => RepositoryError.make({ message: error.message })
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

const decode = (row: typeof rikaThreads.$inferSelect) =>
  Effect.gen(function* () {
    const labels = yield* Schema.decodeEffect(LabelsJson)(row.labelsJson)
    const lineage = yield* Schema.decodeEffect(LineageJson)(row.lineageJson)
    const id = yield* Schema.decodeEffect(ThreadId)(row.id)
    return {
      id,
      workspace: row.workspace,
      title: row.title,
      labels,
      pinned: row.pinned === 1,
      archived: row.archived === 1,
      lineage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }).pipe(Effect.mapError(repositoryError))

export const layerForOwner = (ownerId: string) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* PgDrizzle.makeWithDefaults()
      const get = Effect.fn("ThreadRepository.get")(function* (id: ThreadId) {
        const rows = yield* db.select().from(rikaThreads).where(and(
          eq(rikaThreads.id, id),
          eq(rikaThreads.ownerId, ownerId),
          notExists(db.select({ threadId: rikaThreadDeletionOutbox.threadId }).from(rikaThreadDeletionOutbox)
            .where(eq(rikaThreadDeletionOutbox.threadId, rikaThreads.id))),
        )).pipe(Effect.mapError(repositoryError))
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
        const values: Partial<typeof rikaThreads.$inferInsert> = { updatedAt: now }
        if (fields.title !== undefined) values.title = fields.title
        if (fields.labels !== undefined)
          values.labelsJson = yield* Schema.encodeEffect(LabelsJson)(fields.labels).pipe(Effect.mapError(repositoryError))
        if (fields.pinned !== undefined) values.pinned = Number(fields.pinned)
        if (fields.archived !== undefined) values.archived = Number(fields.archived)
        yield* db.update(rikaThreads).set(values).where(and(
          eq(rikaThreads.id, id),
          eq(rikaThreads.ownerId, ownerId),
        )).pipe(Effect.mapError(repositoryError))
        return yield* requireThread(id)
      })
      const insert = Effect.fn("ThreadRepository.insert")(function* (input: CreateInput) {
        yield* db.insert(rikaWorkspaces).values({ ownerId, path: input.workspace, createdAt: input.now })
          .onConflictDoNothing().pipe(Effect.mapError(repositoryError))
        const lineage = yield* Schema.encodeEffect(LineageJson)(input.lineage ?? { _tag: "Original" }).pipe(
          Effect.mapError(repositoryError),
        )
        yield* db.insert(rikaThreads).values({ id: input.id, ownerId, workspace: input.workspace, title: input.title,
          labelsJson: "[]", pinned: 0, archived: 0, lineageJson: lineage, createdAt: input.now, updatedAt: input.now })
          .pipe(Effect.mapError(repositoryError))
        return yield* requireThread(input.id)
      })
      return Service.of({
        create: Effect.fn("ThreadRepository.create")(function* (input) {
          return yield* db.transaction(() => insert(input)).pipe(Effect.mapError(repositoryError))
        }),
        archiveAndCreate: Effect.fn("ThreadRepository.archiveAndCreate")(function* (currentId, input) {
          return yield* db.transaction((tx) =>
              Effect.gen(function* () {
                yield* requireThread(currentId)
                const created = yield* insert(input)
                yield* tx.update(rikaThreads).set({ archived: 1, updatedAt: input.now }).where(and(
                  eq(rikaThreads.id, currentId), eq(rikaThreads.ownerId, ownerId),
                )).pipe(Effect.mapError(repositoryError))
                return created
              }))
            .pipe(Effect.mapError(repositoryError))
        }),
        get,
        list: Effect.fn("ThreadRepository.list")(function* (input = {}) {
          const filters = [eq(rikaThreads.ownerId, ownerId), notExists(db.select({ threadId: rikaThreadDeletionOutbox.threadId })
            .from(rikaThreadDeletionOutbox).where(eq(rikaThreadDeletionOutbox.threadId, rikaThreads.id)))]
          if (input.includeArchived !== true) filters.push(eq(rikaThreads.archived, 0))
          if (input.query !== undefined) filters.push(or(
            ilike(rikaThreads.title, `%${input.query}%`), ilike(rikaThreads.workspace, `%${input.query}%`),
            ilike(rikaThreads.labelsJson, `%${input.query}%`),
          )!)
          const rows = yield* db.select().from(rikaThreads).where(and(...filters))
            .orderBy(desc(rikaThreads.pinned), desc(rikaThreads.updatedAt), asc(rikaThreads.id))
            .limit(listLimit(input.limit)).pipe(Effect.mapError(repositoryError))
          const threads = yield* Effect.all(rows.map(decode))
          return select(threads, input)
        }),
        listAll: Effect.gen(function* () {
          const rows = yield* db.select().from(rikaThreads).where(and(eq(rikaThreads.ownerId, ownerId),
            notExists(db.select({ threadId: rikaThreadDeletionOutbox.threadId }).from(rikaThreadDeletionOutbox)
              .where(eq(rikaThreadDeletionOutbox.threadId, rikaThreads.id))))).pipe(Effect.mapError(repositoryError))
          return (yield* Effect.all(rows.map(decode))).toSorted(compare)
        }),
        rename: (id, title, now) => update(id, now, { title }),
        renameIfTitle: Effect.fn("ThreadRepository.renameIfTitle")(function* (id, expected, title, now) {
          const rows = yield* db.update(rikaThreads).set({ title, updatedAt: now }).where(and(
            eq(rikaThreads.id, id), eq(rikaThreads.ownerId, ownerId), eq(rikaThreads.title, expected),
            notExists(db.select({ threadId: rikaThreadDeletionOutbox.threadId }).from(rikaThreadDeletionOutbox)
              .where(eq(rikaThreadDeletionOutbox.threadId, rikaThreads.id))),
          )).returning().pipe(Effect.mapError(repositoryError))
          return rows[0] === undefined ? undefined : yield* decode(rows[0])
        }),
        label: (id, labels, now) => update(id, now, { labels: [...new Set(labels)] }),
        setPinned: (id, pinned, now) => update(id, now, { pinned }),
        setArchived: (id, archived, now) => update(id, now, { archived }),
        requestDeletion: Effect.fn("ThreadRepository.requestDeletion")(function* (id, requestedAt) {
          const rows = yield* db.select({ id: rikaThreads.id }).from(rikaThreads)
            .where(and(eq(rikaThreads.id, id), eq(rikaThreads.ownerId, ownerId))).pipe(Effect.mapError(repositoryError))
          if (rows[0] === undefined) return yield* missing(id)
          yield* db.insert(rikaThreadDeletionOutbox).values({ threadId: id, requestedAt }).onConflictDoNothing()
            .pipe(Effect.mapError(repositoryError))
        }),
        pendingDeletions: Effect.gen(function* () {
          const rows = yield* db.select({ threadId: rikaThreadDeletionOutbox.threadId, requestedAt: rikaThreadDeletionOutbox.requestedAt })
            .from(rikaThreadDeletionOutbox).innerJoin(rikaThreads, eq(rikaThreads.id, rikaThreadDeletionOutbox.threadId))
            .where(eq(rikaThreads.ownerId, ownerId)).orderBy(asc(rikaThreadDeletionOutbox.requestedAt), asc(rikaThreadDeletionOutbox.threadId))
            .pipe(Effect.mapError(repositoryError))
          return yield* Effect.forEach(rows, (row) =>
            Schema.decodeEffect(ThreadId)(row.threadId).pipe(
              Effect.map((threadId) => ({ threadId, requestedAt: Number(row.requestedAt) })),
              Effect.mapError(repositoryError),
            ),
          )
        }),
        completeDeletion: Effect.fn("ThreadRepository.completeDeletion")(function* (id) {
          yield* db.transaction((tx) => tx.delete(rikaThreads).where(and(eq(rikaThreads.id, id), eq(rikaThreads.ownerId, ownerId))))
            .pipe(Effect.mapError(repositoryError))
        }),
        discard: Effect.fn("ThreadRepository.discard")(function* (id) {
          const rows = yield* db.select({ id: rikaThreads.id }).from(rikaThreads)
            .where(and(eq(rikaThreads.id, id), eq(rikaThreads.ownerId, ownerId))).pipe(Effect.mapError(repositoryError))
          if (rows[0] === undefined) return yield* missing(id)
          yield* db.delete(rikaThreads).where(and(eq(rikaThreads.id, id), eq(rikaThreads.ownerId, ownerId)))
            .pipe(Effect.mapError(repositoryError))
        }),
      })
    }),
  )

export const layer = layerForOwner("local")

export { makeMemory, memoryLayer } from "./memory-repository"
