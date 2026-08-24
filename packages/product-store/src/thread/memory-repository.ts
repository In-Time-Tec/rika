import { Service } from "@rika/product/thread-repository"

export { Service }
import { Effect, Layer, Ref, Schema } from "effect"
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

export const makeMemory = (initial: ReadonlyArray<Thread> = []) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(new Map(initial.map((thread) => [thread.id, clone(thread)])))
    const deletions = yield* Ref.make(new Map<ThreadId, number>())
    const requireThread = Effect.fn("ThreadRepository.requireThread")(function* (id: ThreadId) {
      const thread = (yield* Ref.get(state)).get(id)
      if (thread === undefined || (yield* Ref.get(deletions)).has(id)) return yield* missing(id)
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
          lineage: input.lineage ?? { _tag: "Original" },
          createdAt: input.now,
          updatedAt: input.now,
        }
        yield* Ref.update(state, (values) => new Map(values).set(thread.id, thread))
        return clone(thread)
      }),
      archiveAndCreate: Effect.fn("ThreadRepository.archiveAndCreate")(function* (currentId, input) {
        const threads = yield* Ref.get(state)
        const current = yield* requireThread(currentId)
        if (threads.has(input.id)) {
          return yield* RepositoryError.make({ message: `Thread ${input.id} exists` })
        }
        const created: Thread = {
          id: input.id,
          workspace: input.workspace,
          title: input.title,
          labels: [],
          pinned: false,
          archived: false,
          lineage: input.lineage ?? { _tag: "Original" },
          createdAt: input.now,
          updatedAt: input.now,
        }
        yield* Ref.set(
          state,
          new Map(threads)
            .set(currentId, { ...current, archived: true, updatedAt: input.now })
            .set(created.id, created),
        )
        return clone(created)
      }),
      get: Effect.fn("ThreadRepository.get")(function* (id) {
        const thread = (yield* Ref.get(state)).get(id)
        return thread === undefined || (yield* Ref.get(deletions)).has(id) ? undefined : clone(thread)
      }),
      list: Effect.fn("ThreadRepository.list")(function* (input = {}) {
        const tombstones = yield* Ref.get(deletions)
        return select(
          [...(yield* Ref.get(state)).values()].filter((thread) => !tombstones.has(thread.id)),
          input,
        )
      }),
      listAll: Effect.gen(function* () {
        const tombstones = yield* Ref.get(deletions)
        return [...(yield* Ref.get(state)).values()]
          .filter((thread) => !tombstones.has(thread.id))
          .toSorted(compare)
          .map(clone)
      }),
      rename: (id, title, now) => update(id, now, (thread) => ({ ...thread, title })),
      renameIfTitle: Effect.fn("ThreadRepository.renameIfTitle")(function* (id, expected, title, now) {
        if ((yield* Ref.get(deletions)).has(id)) return undefined
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
      requestDeletion: Effect.fn("ThreadRepository.requestDeletion")(function* (id, requestedAt) {
        if (!(yield* Ref.get(state)).has(id)) return yield* missing(id)
        yield* Ref.update(deletions, (current) => (current.has(id) ? current : new Map(current).set(id, requestedAt)))
      }),
      pendingDeletions: Ref.get(deletions).pipe(
        Effect.map((current) =>
          [...current]
            .map(([threadId, requestedAt]) => ({ threadId, requestedAt }))
            .toSorted(
              (left, right) => left.requestedAt - right.requestedAt || left.threadId.localeCompare(right.threadId),
            ),
        ),
      ),
      completeDeletion: Effect.fn("ThreadRepository.completeDeletion")(function* (id) {
        yield* Ref.update(state, (threads) => {
          const next = new Map(threads)
          next.delete(id)
          return next
        })
        yield* Ref.update(deletions, (current) => {
          const next = new Map(current)
          next.delete(id)
          return next
        })
      }),
      discard: Effect.fn("ThreadRepository.discard")(function* (id) {
        if (!(yield* Ref.get(state)).has(id)) return yield* missing(id)
        yield* Ref.update(state, (threads) => {
          const next = new Map(threads)
          next.delete(id)
          return next
        })
      }),
    })
  })

export const memoryLayer = (initial: ReadonlyArray<Thread> = []) => Layer.effect(Service, makeMemory(initial))
