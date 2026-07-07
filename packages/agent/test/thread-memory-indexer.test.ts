import { describe, expect, test } from "bun:test"
import { Diagnostics, IdGenerator, SecretRedactor, Time } from "@rika/core"
import { Embeddings } from "@rika/llm"
import { Database, Migration, ThreadEventLog, ThreadMemoryStore, ThreadProjection } from "@rika/persistence"
import { Common, Event, Ids, Message } from "@rika/schema"
import { Effect, Layer, Option } from "effect"
import { ThreadMemoryIndexer } from "../src/index"

const workspaceId = Ids.WorkspaceId.make("workspace_memory_indexer")
const threadId = Ids.ThreadId.make("thread_memory_indexer")
const turnId = Ids.TurnId.make("turn_memory_indexer")
const now = Common.TimestampMillis.make(1_966_000_000_000)

describe("ThreadMemoryIndexer", () => {
  test("indexes a completed turn into thread memory", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* appendFixtureTurn()
        const indexed = yield* ThreadMemoryIndexer.indexTurn({ thread_id: threadId, turn_id: turnId })
        const stored = yield* ThreadMemoryStore.getByTurn({ thread_id: threadId, turn_id: turnId })
        return { indexed, stored }
      }).pipe(Effect.provide(testLayer(Embeddings.fakeLayer({ dimensions: 8 })))),
    )

    expect(result.indexed).toMatchObject({ status: "indexed", thread_id: threadId, turn_id: turnId })
    expect(Option.getOrUndefined(result.stored)?.text).toContain("Remember this")
    expect(Option.getOrUndefined(result.stored)?.embedding).toBeInstanceOf(Float32Array)
  })

  test("skips unavailable embeddings without writing a chunk", async () => {
    const diagnostics: Array<Diagnostics.Entry> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* appendFixtureTurn()
        const indexed = yield* ThreadMemoryIndexer.indexTurn({ thread_id: threadId, turn_id: turnId })
        const stored = yield* ThreadMemoryStore.getByTurn({ thread_id: threadId, turn_id: turnId })
        return { indexed, stored }
      }).pipe(Effect.provide(testLayer(Embeddings.layer(Embeddings.optionsFromEnv({})), diagnostics))),
    )

    expect(result.indexed).toMatchObject({ status: "skipped", reason: "embeddings_unavailable" })
    expect(Option.isNone(result.stored)).toBe(true)
    expect(diagnostics.some((entry) => entry.message.includes("thread.memory.index"))).toBe(true)
  })

  test("backfill is idempotent without re-embedding existing turns", async () => {
    const embeddedTexts: Array<string> = []

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* appendFixtureTurn()
        const first = yield* ThreadMemoryIndexer.backfill({ workspace_id: workspaceId })
        const second = yield* ThreadMemoryIndexer.backfill({ workspace_id: workspaceId })
        const chunks = yield* ThreadMemoryStore.count({ workspace_id: workspaceId })
        return { first, second, chunks, embeddedTexts }
      }).pipe(Effect.provide(testLayer(countingEmbeddingsLayer(embeddedTexts)))),
    )

    expect(result.first).toMatchObject({ indexed: 1, skipped: 0, failed: 0 })
    expect(result.second).toMatchObject({ indexed: 0, skipped: 0, failed: 0 })
    expect(result.chunks).toBe(1)
    expect(result.embeddedTexts).toHaveLength(1)
  })
})

const testLayer = (embeddingsLayer: Layer.Layer<Embeddings.Service>, diagnostics: Array<Diagnostics.Entry> = []) => {
  const databaseLayer = Database.memoryLayer
  const redactorLayer = SecretRedactor.layer
  const diagnosticsLayer = Diagnostics.memoryLayer(diagnostics).pipe(Layer.provideMerge(redactorLayer))
  const storageLayer = Layer.mergeAll(
    databaseLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    ThreadMemoryStore.layer.pipe(Layer.provideMerge(databaseLayer)),
    Time.fixedLayer(now),
    IdGenerator.sequenceLayer(1),
    redactorLayer,
    diagnosticsLayer,
  )
  return ThreadMemoryIndexer.layer.pipe(
    Layer.provideMerge(storageLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
}

const countingEmbeddingsLayer = (texts: Array<string>) =>
  Layer.succeed(
    Embeddings.Service,
    Embeddings.Service.of({
      dimensions: 8,
      availability: Effect.succeed({ available: true, model: "counting", dimensions: 8 }),
      embed: Effect.fn("Embeddings.embed.counting")(function* (input: ReadonlyArray<string>) {
        yield* Effect.sync(() => texts.push(...input))
        return input.map(() => new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]))
      }),
    }),
  )

const appendFixtureTurn = () =>
  Effect.gen(function* () {
    for (const event of fixtureTurn()) {
      const appended = yield* ThreadEventLog.append(event)
      yield* ThreadProjection.apply(appended)
    }
  })

const fixtureTurn = (): ReadonlyArray<Event.Event> => [
  {
    id: Ids.EventId.make("event_memory_indexer_thread_created"),
    thread_id: threadId,
    sequence: 1,
    version: 1,
    created_at: now,
    type: "thread.created",
    data: { workspace_id: workspaceId },
  },
  message(2, "user", "Remember this"),
  message(3, "assistant", "Stored"),
  {
    id: Ids.EventId.make("event_memory_indexer_completed"),
    thread_id: threadId,
    turn_id: turnId,
    sequence: 4,
    version: 1,
    created_at: now,
    type: "turn.completed",
    data: {},
  },
]

const message = (sequence: number, role: Message.Role, text: string): Event.MessageAdded => ({
  id: Ids.EventId.make(`event_memory_indexer_message_${sequence}`),
  thread_id: threadId,
  turn_id: turnId,
  sequence,
  version: 1,
  created_at: now,
  type: "message.added",
  data: {
    message: {
      id: Ids.MessageId.make(`message_memory_indexer_${sequence}`),
      thread_id: threadId,
      turn_id: turnId,
      role,
      content: [Message.text(text)],
      created_at: now,
    },
  },
})
