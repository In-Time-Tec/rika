import { describe, expect, test } from "bun:test"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer, Option } from "effect"
import { Database, Migration, ThreadMemoryStore } from "../src/index"

const workspaceId = Ids.WorkspaceId.make("workspace_memory_store")
const threadId = Ids.ThreadId.make("thread_memory_store")
const forkThreadId = Ids.ThreadId.make("thread_memory_store_fork")
const turnId = Ids.TurnId.make("turn_memory_store")
const now = Common.TimestampMillis.make(1_966_000_000_000)

const databaseLayer = Database.memoryLayer
const layer = Layer.mergeAll(
  databaseLayer,
  Migration.layer,
  ThreadMemoryStore.layer.pipe(Layer.provideMerge(databaseLayer)),
)

describe("ThreadMemoryStore", () => {
  test("stores chunks, allows fork-preserved turn ids, and keeps thread-turn uniqueness idempotent", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadMemoryStore.put(chunk("chunk_a", threadId, turnId, "source", [1, 0]))
        yield* ThreadMemoryStore.put(chunk("chunk_duplicate", threadId, turnId, "duplicate", [0, 1]))
        yield* ThreadMemoryStore.put(chunk("chunk_fork", forkThreadId, turnId, "fork", [0, 1]))
        const source = yield* ThreadMemoryStore.getByTurn({ thread_id: threadId, turn_id: turnId })
        const fork = yield* ThreadMemoryStore.getByTurn({ thread_id: forkThreadId, turn_id: turnId })
        const missing = yield* ThreadMemoryStore.missingTurns([
          { thread_id: threadId, turn_id: turnId },
          { thread_id: threadId, turn_id: Ids.TurnId.make("turn_missing") },
        ])
        return { source, fork, missing }
      }).pipe(Effect.provide(layer)),
    )

    expect(Option.getOrUndefined(result.source)?.text).toBe("source")
    expect(Option.getOrUndefined(result.fork)?.text).toBe("fork")
    expect(result.missing).toEqual([{ thread_id: threadId, turn_id: Ids.TurnId.make("turn_missing") }])
  })

  test("ranks cosine matches after applying workspace and excluded-thread filters", async () => {
    const otherWorkspace = Ids.WorkspaceId.make("workspace_other")
    const excludedThread = Ids.ThreadId.make("thread_excluded")

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Migration.migrate()
        yield* ThreadMemoryStore.put(chunk("chunk_target", threadId, Ids.TurnId.make("turn_target"), "target", [1, 0]))
        yield* ThreadMemoryStore.put(
          chunk(
            "chunk_other_workspace",
            Ids.ThreadId.make("thread_other"),
            Ids.TurnId.make("turn_other"),
            "other",
            [1, 0],
            {
              workspace_id: otherWorkspace,
              created_at: Common.TimestampMillis.make(now + 2),
            },
          ),
        )
        yield* ThreadMemoryStore.put(
          chunk("chunk_excluded", excludedThread, Ids.TurnId.make("turn_excluded"), "excluded", [1, 0], {
            created_at: Common.TimestampMillis.make(now + 1),
          }),
        )
        return yield* ThreadMemoryStore.search(new Float32Array([1, 0]), {
          workspace_id: workspaceId,
          exclude_thread_id: excludedThread,
          limit: 5,
        })
      }).pipe(Effect.provide(layer)),
    )

    expect(results.map((result) => result.chunk.text)).toEqual(["target"])
    expect(results[0]?.score).toBe(1)
  })
})

const chunk = (
  id: string,
  thread_id: Ids.ThreadId,
  turn_id: Ids.TurnId,
  text: string,
  embedding: ReadonlyArray<number>,
  overrides: Partial<ThreadMemoryStore.ThreadMemoryChunk> = {},
): ThreadMemoryStore.ThreadMemoryChunk => ({
  id: Ids.ThreadMemoryChunkId.make(id),
  thread_id,
  turn_id,
  workspace_id: workspaceId,
  text,
  embedding: new Float32Array(embedding),
  created_at: now,
  ...overrides,
})
