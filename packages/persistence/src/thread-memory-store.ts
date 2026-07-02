import { Buffer } from "node:buffer"
import { Common, Ids } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import * as Database from "./database"

export interface ThreadMemoryChunk {
  readonly id: Ids.ThreadMemoryChunkId
  readonly thread_id: Ids.ThreadId
  readonly turn_id: Ids.TurnId
  readonly workspace_id: Ids.WorkspaceId
  readonly text: string
  readonly embedding: Float32Array
  readonly created_at: Common.TimestampMillis
}

export interface TurnKey {
  readonly thread_id: Ids.ThreadId
  readonly turn_id: Ids.TurnId
}

export interface SearchInput {
  readonly workspace_id?: Ids.WorkspaceId
  readonly limit?: number
  readonly exclude_thread_id?: Ids.ThreadId
}

export interface CountInput {
  readonly workspace_id?: Ids.WorkspaceId
}

export interface SearchResult {
  readonly chunk: ThreadMemoryChunk
  readonly score: number
}

export class ThreadMemoryStoreError extends Schema.TaggedErrorClass<ThreadMemoryStoreError>()(
  "ThreadMemoryStoreError",
  {
    message: Schema.String,
    operation: Schema.String,
    chunk_id: Schema.optional(Ids.ThreadMemoryChunkId),
    thread_id: Schema.optional(Ids.ThreadId),
    turn_id: Schema.optional(Ids.TurnId),
  },
) {}

export interface Interface {
  readonly put: (
    chunk: ThreadMemoryChunk,
  ) => Effect.Effect<ThreadMemoryChunk, Database.DatabaseError | ThreadMemoryStoreError>
  readonly getByTurn: (
    key: TurnKey,
  ) => Effect.Effect<Option.Option<ThreadMemoryChunk>, Database.DatabaseError | ThreadMemoryStoreError>
  readonly missingTurns: (
    keys: ReadonlyArray<TurnKey>,
  ) => Effect.Effect<ReadonlyArray<TurnKey>, Database.DatabaseError | ThreadMemoryStoreError>
  readonly search: (
    embedding: Float32Array,
    input: SearchInput,
  ) => Effect.Effect<ReadonlyArray<SearchResult>, Database.DatabaseError | ThreadMemoryStoreError>
  readonly latestIndexedTurn: (
    threadId: Ids.ThreadId,
  ) => Effect.Effect<Option.Option<Ids.TurnId>, Database.DatabaseError | ThreadMemoryStoreError>
  readonly count: (input?: CountInput) => Effect.Effect<number, Database.DatabaseError | ThreadMemoryStoreError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/persistence/ThreadMemoryStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const databaseService = yield* Database.Service
    return Service.of({
      put: Effect.fn("ThreadMemoryStore.put")(function* (chunk: ThreadMemoryChunk) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => {
              validateVector(chunk.embedding, "put")
              database.run(sql`
                insert or ignore into thread_memory_chunks (
                  id,
                  thread_id,
                  turn_id,
                  workspace_id,
                  text,
                  embedding,
                  created_at
                ) values (
                  ${chunk.id},
                  ${chunk.thread_id},
                  ${chunk.turn_id},
                  ${chunk.workspace_id},
                  ${chunk.text},
                  ${embeddingToBuffer(chunk.embedding)},
                  ${chunk.created_at}
                )
              `)
              return chunk
            },
            catch: (cause) => toError(cause, "put", chunk),
          }),
        )
      }),
      getByTurn: Effect.fn("ThreadMemoryStore.getByTurn")(function* (key: TurnKey) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => rowToChunk(selectByTurn(database, key)),
            catch: (cause) => toError(cause, "getByTurn", key),
          }),
        )
      }),
      missingTurns: Effect.fn("ThreadMemoryStore.missingTurns")(function* (keys: ReadonlyArray<TurnKey>) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => keys.filter((key) => selectByTurn(database, key) === undefined),
            catch: (cause) => toError(cause, "missingTurns"),
          }),
        )
      }),
      search: Effect.fn("ThreadMemoryStore.search")(function* (embedding: Float32Array, input: SearchInput) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => {
              validateVector(embedding, "search")
              return searchRows(database, embedding, input)
            },
            catch: (cause) => toError(cause, "search"),
          }),
        )
      }),
      latestIndexedTurn: Effect.fn("ThreadMemoryStore.latestIndexedTurn")(function* (threadId: Ids.ThreadId) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => {
              const row = database.get<TurnIdRow>(sql`
                select turn_id from thread_memory_chunks
                where thread_id = ${threadId}
                order by created_at desc
                limit 1
              `)
              return row === undefined ? Option.none<Ids.TurnId>() : Option.some(Ids.TurnId.make(row.turn_id))
            },
            catch: (cause) => toError(cause, "latestIndexedTurn", { thread_id: threadId }),
          }),
        )
      }),
      count: Effect.fn("ThreadMemoryStore.count")(function* (input: CountInput = {}) {
        return yield* databaseService.withDatabaseEffect((database) =>
          Effect.try({
            try: () => countRows(database, input),
            catch: (cause) => toError(cause, "count"),
          }),
        )
      }),
    })
  }),
)

export const memoryLayer = (initial: ReadonlyArray<ThreadMemoryChunk> = []) => {
  const rows = new Map(initial.map((chunk) => [keyString(chunk), chunk]))
  return Layer.succeed(
    Service,
    Service.of({
      put: Effect.fn("ThreadMemoryStore.put.memory")(function* (chunk: ThreadMemoryChunk) {
        yield* Effect.sync(() => {
          if (!rows.has(keyString(chunk))) rows.set(keyString(chunk), chunk)
        })
        return chunk
      }),
      getByTurn: Effect.fn("ThreadMemoryStore.getByTurn.memory")(function* (key: TurnKey) {
        return Option.fromNullishOr(rows.get(keyString(key)))
      }),
      missingTurns: Effect.fn("ThreadMemoryStore.missingTurns.memory")(function* (keys: ReadonlyArray<TurnKey>) {
        return keys.filter((key) => !rows.has(keyString(key)))
      }),
      search: Effect.fn("ThreadMemoryStore.search.memory")(function* (embedding: Float32Array, input: SearchInput) {
        validateVector(embedding, "search")
        return rankChunks([...rows.values()], embedding, input)
      }),
      latestIndexedTurn: Effect.fn("ThreadMemoryStore.latestIndexedTurn.memory")(function* (threadId: Ids.ThreadId) {
        const chunk = [...rows.values()]
          .filter((row) => row.thread_id === threadId)
          .toSorted((left, right) => right.created_at - left.created_at)[0]
        return chunk === undefined ? Option.none<Ids.TurnId>() : Option.some(chunk.turn_id)
      }),
      count: Effect.fn("ThreadMemoryStore.count.memory")(function* (input: CountInput = {}) {
        return [...rows.values()].filter(
          (row) => input.workspace_id === undefined || row.workspace_id === input.workspace_id,
        ).length
      }),
    }),
  )
}

export const put = Effect.fn("ThreadMemoryStore.put.call")(function* (chunk: ThreadMemoryChunk) {
  const store = yield* Service
  return yield* store.put(chunk)
})

export const getByTurn = Effect.fn("ThreadMemoryStore.getByTurn.call")(function* (key: TurnKey) {
  const store = yield* Service
  return yield* store.getByTurn(key)
})

export const missingTurns = Effect.fn("ThreadMemoryStore.missingTurns.call")(function* (keys: ReadonlyArray<TurnKey>) {
  const store = yield* Service
  return yield* store.missingTurns(keys)
})

export const search = Effect.fn("ThreadMemoryStore.search.call")(function* (
  embedding: Float32Array,
  input: SearchInput,
) {
  const store = yield* Service
  return yield* store.search(embedding, input)
})

export const latestIndexedTurn = Effect.fn("ThreadMemoryStore.latestIndexedTurn.call")(function* (
  threadId: Ids.ThreadId,
) {
  const store = yield* Service
  return yield* store.latestIndexedTurn(threadId)
})

export const count = Effect.fn("ThreadMemoryStore.count.call")(function* (input: CountInput = {}) {
  const store = yield* Service
  return yield* store.count(input)
})

type ThreadMemoryDatabase = Pick<Database.DrizzleDatabase, "all" | "get" | "run">

interface ThreadMemoryChunkRow {
  readonly id: string
  readonly thread_id: string
  readonly turn_id: string
  readonly workspace_id: string
  readonly text: string
  readonly embedding: Buffer
  readonly created_at: number
}

interface TurnIdRow {
  readonly turn_id: string
}

interface CountRow {
  readonly count: number
}

const candidateLimit = 20_000

const selectByTurn = (database: ThreadMemoryDatabase, key: TurnKey) =>
  database.get<ThreadMemoryChunkRow>(sql`
    select * from thread_memory_chunks
    where thread_id = ${key.thread_id} and turn_id = ${key.turn_id}
    limit 1
  `)

const searchRows = (database: ThreadMemoryDatabase, embedding: Float32Array, input: SearchInput) => {
  const workspace = input.workspace_id === undefined ? sql`1 = 1` : sql`workspace_id = ${input.workspace_id}`
  const excluded = input.exclude_thread_id === undefined ? sql`1 = 1` : sql`thread_id <> ${input.exclude_thread_id}`
  const rows = database.all<ThreadMemoryChunkRow>(sql`
    select * from thread_memory_chunks
    where ${workspace} and ${excluded}
    order by created_at desc
    limit ${candidateLimit}
  `)
  return rankChunks(
    rows.flatMap((row) => Option.match(rowToChunk(row), { onNone: () => [], onSome: (chunk) => [chunk] })),
    embedding,
    input,
  )
}

const countRows = (database: ThreadMemoryDatabase, input: CountInput) => {
  const row =
    input.workspace_id === undefined
      ? database.get<CountRow>(sql`select count(*) as count from thread_memory_chunks`)
      : database.get<CountRow>(
          sql`select count(*) as count from thread_memory_chunks where workspace_id = ${input.workspace_id}`,
        )
  return row?.count ?? 0
}

const rankChunks = (chunks: ReadonlyArray<ThreadMemoryChunk>, embedding: Float32Array, input: SearchInput) =>
  chunks
    .filter((chunk) => input.workspace_id === undefined || chunk.workspace_id === input.workspace_id)
    .filter((chunk) => input.exclude_thread_id === undefined || chunk.thread_id !== input.exclude_thread_id)
    .toSorted((left, right) => right.created_at - left.created_at)
    .slice(0, candidateLimit)
    .map((chunk) => ({ chunk, score: cosine(embedding, chunk.embedding) }))
    .filter((result) => Number.isFinite(result.score))
    .toSorted((left, right) => right.score - left.score || right.chunk.created_at - left.chunk.created_at)
    .slice(0, input.limit ?? 10)

const rowToChunk = (row: ThreadMemoryChunkRow | undefined): Option.Option<ThreadMemoryChunk> => {
  if (row === undefined) return Option.none()
  const embedding = bufferToEmbedding(row.embedding)
  if (Option.isNone(embedding)) return Option.none()
  return Option.some({
    id: Ids.ThreadMemoryChunkId.make(row.id),
    thread_id: Ids.ThreadId.make(row.thread_id),
    turn_id: Ids.TurnId.make(row.turn_id),
    workspace_id: Ids.WorkspaceId.make(row.workspace_id),
    text: row.text,
    embedding: embedding.value,
    created_at: Common.TimestampMillis.make(row.created_at),
  })
}

export const embeddingToBuffer = (embedding: Float32Array): Buffer => {
  const buffer = new ArrayBuffer(embedding.length * 4)
  const view = new DataView(buffer)
  for (let index = 0; index < embedding.length; index += 1) {
    view.setFloat32(index * 4, embedding[index] ?? 0, true)
  }
  return Buffer.from(new Uint8Array(buffer))
}

export const bufferToEmbedding = (buffer: Buffer | Uint8Array): Option.Option<Float32Array> => {
  if (buffer.byteLength % 4 !== 0) return Option.none()
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const embedding = new Float32Array(buffer.byteLength / 4)
  for (let index = 0; index < embedding.length; index += 1) {
    const value = view.getFloat32(index * 4, true)
    if (!Number.isFinite(value)) return Option.none()
    embedding[index] = value
  }
  return Option.some(embedding)
}

const cosine = (left: Float32Array, right: Float32Array) => {
  if (left.length !== right.length || left.length === 0) return Number.NEGATIVE_INFINITY
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return Number.NEGATIVE_INFINITY
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude))
}

const validateVector = (embedding: Float32Array, operation: string) => {
  if (embedding.length === 0) {
    throw new ThreadMemoryStoreError({ message: "Embedding vector is empty", operation })
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) throw new ThreadMemoryStoreError({ message: "Embedding vector is invalid", operation })
  }
}

const keyString = (key: TurnKey) => `${key.thread_id}\u0000${key.turn_id}`

const toError = (cause: unknown, operation: string, input?: Partial<ThreadMemoryChunk> | TurnKey) => {
  if (cause instanceof ThreadMemoryStoreError) return cause
  const chunkId = input !== undefined && "id" in input ? input.id : undefined
  return new ThreadMemoryStoreError({
    message: cause instanceof Error ? cause.message : String(cause),
    operation,
    ...(input?.thread_id === undefined ? {} : { thread_id: input.thread_id }),
    ...(input?.turn_id === undefined ? {} : { turn_id: input.turn_id }),
    ...(chunkId === undefined ? {} : { chunk_id: chunkId }),
  })
}
