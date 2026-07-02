import { Diagnostics, IdGenerator, Time } from "@rika/core"
import { Embeddings } from "@rika/llm"
import { Database, ThreadEventLog, ThreadMemoryStore } from "@rika/persistence"
import { Event, Ids } from "@rika/schema"
import { Context, Effect, Layer, Option, Schema } from "effect"
import * as ThreadDigest from "./thread-digest"

export interface IndexTurnInput {
  readonly thread_id: Ids.ThreadId
  readonly turn_id: Ids.TurnId
}

export type SkipReason = "already_indexed" | "no_digest" | "embeddings_unavailable"

export type IndexTurnResult =
  | {
      readonly status: "indexed"
      readonly thread_id: Ids.ThreadId
      readonly turn_id: Ids.TurnId
      readonly chunk_id: Ids.ThreadMemoryChunkId
    }
  | {
      readonly status: "skipped"
      readonly reason: SkipReason
      readonly thread_id: Ids.ThreadId
      readonly turn_id: Ids.TurnId
    }

export interface BackfillInput {
  readonly workspace_id?: Ids.WorkspaceId
}

export interface BackfillResult {
  readonly workspace_id?: Ids.WorkspaceId
  readonly indexed: number
  readonly skipped: number
  readonly failed: number
}

export interface StatusInput {
  readonly workspace_id?: Ids.WorkspaceId
}

export interface StatusResult {
  readonly chunk_count: number
  readonly embeddings: Embeddings.Availability
}

export class ThreadMemoryIndexerError extends Schema.TaggedErrorClass<ThreadMemoryIndexerError>()(
  "ThreadMemoryIndexerError",
  {
    message: Schema.String,
    operation: Schema.String,
    thread_id: Schema.optional(Ids.ThreadId),
    turn_id: Schema.optional(Ids.TurnId),
  },
) {}

export type RunError =
  | Database.DatabaseError
  | ThreadEventLog.ThreadEventLogError
  | ThreadMemoryStore.ThreadMemoryStoreError
  | Embeddings.EmbeddingsProviderError
  | Embeddings.EmbeddingsValidationError
  | ThreadMemoryIndexerError

export interface Interface {
  readonly indexTurn: (input: IndexTurnInput) => Effect.Effect<IndexTurnResult, RunError>
  readonly backfill: (input: BackfillInput) => Effect.Effect<BackfillResult, RunError>
  readonly status: (input?: StatusInput) => Effect.Effect<StatusResult, RunError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/agent/ThreadMemoryIndexer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const eventLog = yield* ThreadEventLog.Service
    const store = yield* ThreadMemoryStore.Service
    const embeddings = yield* Embeddings.Service
    const idGenerator = yield* IdGenerator.Service
    const time = yield* Time.Service
    const diagnostics = yield* Diagnostics.Service

    const indexTurnImpl = Effect.fn("ThreadMemoryIndexer.indexTurn.impl")(function* (input: IndexTurnInput) {
      const existing = yield* store.getByTurn(input)
      if (Option.isSome(existing)) return skipped(input, "already_indexed")

      const events = yield* eventLog
        .readThread({ thread_id: input.thread_id })
        .pipe(Effect.provideService(Database.Service, database))
      const digest = ThreadDigest.completedTurnDigest(events, input.turn_id)
      if (Option.isNone(digest)) return skipped(input, "no_digest")

      const workspaceId = yield* requireWorkspaceId(events, input)
      const vector = yield* embeddings.embed([digest.value]).pipe(
        Effect.map((vectors) => vectors[0]),
        Effect.flatMap((embedding) =>
          embedding === undefined
            ? Effect.fail(
                new ThreadMemoryIndexerError({
                  message: "Embedding provider returned no vector",
                  operation: "indexTurn",
                  thread_id: input.thread_id,
                  turn_id: input.turn_id,
                }),
              )
            : Effect.succeed(embedding),
        ),
        Effect.catchTag("EmbeddingsUnavailable", () => Effect.succeed(undefined)),
      )
      if (vector === undefined) return skipped(input, "embeddings_unavailable")

      const chunkId = Ids.ThreadMemoryChunkId.make(yield* idGenerator.next("thread_memory_chunk"))
      yield* store.put({
        id: chunkId,
        thread_id: input.thread_id,
        turn_id: input.turn_id,
        workspace_id: workspaceId,
        text: digest.value,
        embedding: vector,
        created_at: yield* time.nowMillis,
      })
      return { status: "indexed" as const, thread_id: input.thread_id, turn_id: input.turn_id, chunk_id: chunkId }
    })

    const service = Service.of({
      indexTurn: Effect.fn("ThreadMemoryIndexer.indexTurn")(function* (input: IndexTurnInput) {
        return yield* Diagnostics.event(
          "thread.memory.index",
          (fields) =>
            indexTurnImpl(input).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  fields.status = result.status
                  if (result.status === "skipped") fields.reason = result.reason
                }),
              ),
            ),
          { thread_id: input.thread_id, turn_id: input.turn_id },
        ).pipe(Effect.provideService(Diagnostics.Service, diagnostics))
      }),
      backfill: Effect.fn("ThreadMemoryIndexer.backfill")(function* (input: BackfillInput) {
        const events = yield* eventLog.readAll().pipe(Effect.provideService(Database.Service, database))
        const keys = completedTurnKeys(events, input.workspace_id)
        const missing = yield* store.missingTurns(keys)
        const results = yield* Effect.forEach(missing, (key) => service.indexTurn(key).pipe(backfillAttempt), {
          concurrency: 1,
        })
        return {
          ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
          indexed: countIndexed(results),
          skipped: countSkipped(results),
          failed: countFailed(results),
        }
      }),
      status: Effect.fn("ThreadMemoryIndexer.status")(function* (input: StatusInput = {}) {
        const chunkCount = yield* store.count(input)
        const availability = yield* embeddings.availability
        return { chunk_count: chunkCount, embeddings: availability }
      }),
    })

    return service
  }),
)

export const fakeLayer = (methods: {
  readonly indexTurn?: (input: IndexTurnInput) => Effect.Effect<IndexTurnResult, RunError>
  readonly backfill?: (input: BackfillInput) => Effect.Effect<BackfillResult, RunError>
  readonly status?: (input: StatusInput) => Effect.Effect<StatusResult, RunError>
}) =>
  Layer.succeed(
    Service,
    Service.of({
      indexTurn: Effect.fn("ThreadMemoryIndexer.indexTurn.fake")(function* (input: IndexTurnInput) {
        if (methods.indexTurn !== undefined) return yield* methods.indexTurn(input)
        return skipped(input, "no_digest")
      }),
      backfill: Effect.fn("ThreadMemoryIndexer.backfill.fake")(function* (input: BackfillInput) {
        if (methods.backfill !== undefined) return yield* methods.backfill(input)
        return {
          ...(input.workspace_id === undefined ? {} : { workspace_id: input.workspace_id }),
          indexed: 0,
          skipped: 0,
          failed: 0,
        }
      }),
      status: Effect.fn("ThreadMemoryIndexer.status.fake")(function* (input: StatusInput = {}) {
        if (methods.status !== undefined) return yield* methods.status(input)
        return {
          chunk_count: 0,
          embeddings: { available: false, reason: "not configured" },
        }
      }),
    }),
  )

export const indexTurn = Effect.fn("ThreadMemoryIndexer.indexTurn.call")(function* (input: IndexTurnInput) {
  const indexer = yield* Service
  return yield* indexer.indexTurn(input)
})

export const backfill = Effect.fn("ThreadMemoryIndexer.backfill.call")(function* (input: BackfillInput) {
  const indexer = yield* Service
  return yield* indexer.backfill(input)
})

export const status = Effect.fn("ThreadMemoryIndexer.status.call")(function* (input: StatusInput = {}) {
  const indexer = yield* Service
  return yield* indexer.status(input)
})

const skipped = (input: IndexTurnInput, reason: SkipReason) => ({
  status: "skipped" as const,
  reason,
  thread_id: input.thread_id,
  turn_id: input.turn_id,
})

const requireWorkspaceId = (events: ReadonlyArray<Event.Event>, input: IndexTurnInput) => {
  const created = events.find((event): event is Event.ThreadCreated => event.type === "thread.created")
  return created === undefined
    ? Effect.fail(
        new ThreadMemoryIndexerError({
          message: `Thread ${input.thread_id} has no thread.created event`,
          operation: "indexTurn",
          thread_id: input.thread_id,
          turn_id: input.turn_id,
        }),
      )
    : Effect.succeed(created.data.workspace_id)
}

const completedTurnKeys = (events: ReadonlyArray<Event.Event>, workspaceId: Ids.WorkspaceId | undefined) => {
  const workspaceByThread = new Map<Ids.ThreadId, Ids.WorkspaceId>()
  const keys = new Map<string, IndexTurnInput>()
  for (const event of events) {
    if (event.type === "thread.created") workspaceByThread.set(event.thread_id, event.data.workspace_id)
    if (event.type === "turn.completed") {
      const eventWorkspace = workspaceByThread.get(event.thread_id)
      if (workspaceId !== undefined && eventWorkspace !== workspaceId) continue
      keys.set(`${event.thread_id}\u0000${event.turn_id}`, { thread_id: event.thread_id, turn_id: event.turn_id })
    }
  }
  return [...keys.values()]
}

type BackfillAttempt = IndexTurnResult | { readonly status: "failed"; readonly error: RunError }

const backfillAttempt = <A extends IndexTurnResult, E extends RunError>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.match({
      onFailure: (error) => ({ status: "failed" as const, error }),
      onSuccess: (result) => result,
    }),
  )

const countIndexed = (results: ReadonlyArray<BackfillAttempt>) =>
  results.filter((result) => result.status === "indexed").length

const countSkipped = (results: ReadonlyArray<BackfillAttempt>) =>
  results.filter((result) => result.status === "skipped").length

const countFailed = (results: ReadonlyArray<BackfillAttempt>) =>
  results.filter((result) => result.status === "failed").length
