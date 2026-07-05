import { describe, expect, test } from "bun:test"
import { SecretRedactor } from "@rika/core"
import { Database, Migration, ThreadEventLog } from "@rika/persistence"
import { Common, Event, Ids } from "@rika/schema"
import { Deferred, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import { ThreadLive } from "../src/index"

const threadId = Ids.ThreadId.make("thread_live_topic_cleanup")
const workspaceId = Ids.WorkspaceId.make("workspace_live_topic_cleanup")

describe("ThreadLive", () => {
  test("shuts down idle topics and recreates them for later subscribers", async () => {
    const firstCreated = Deferred.makeUnsafe<void>()
    const firstRemoved = Deferred.makeUnsafe<void>()
    const secondCreated = Deferred.makeUnsafe<void>()
    const secondRemoved = Deferred.makeUnsafe<void>()
    const created: Array<PubSub.PubSub<Event.Event>> = []
    const removed: Array<PubSub.PubSub<Event.Event>> = []
    const lifecycle: ThreadLive.TopicLifecycle = {
      created: (_threadId, topic) =>
        Effect.gen(function* () {
          created.push(topic)
          yield* Deferred.succeed(created.length === 1 ? firstCreated : secondCreated, undefined)
        }),
      removed: (_threadId, topic) =>
        Effect.gen(function* () {
          removed.push(topic)
          yield* Deferred.succeed(removed.length === 1 ? firstRemoved : secondRemoved, undefined)
        }),
    }

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const firstEvents = yield* collectOne(firstCreated)
          yield* Deferred.await(firstRemoved)
          const firstTopic = created[0]
          const firstShutdown = firstTopic === undefined ? false : yield* PubSub.isShutdown(firstTopic)

          const secondEvents = yield* collectOne(secondCreated)
          yield* Deferred.await(secondRemoved)
          const secondTopic = created[1]
          const secondShutdown = secondTopic === undefined ? false : yield* PubSub.isShutdown(secondTopic)

          return {
            firstEvents: Array.from(firstEvents),
            firstShutdown,
            recreated: firstTopic !== undefined && secondTopic !== undefined && firstTopic !== secondTopic,
            removed: removed.length,
            secondEvents: Array.from(secondEvents),
            secondShutdown,
          }
        }),
      ).pipe(Effect.provide(threadLiveLayer(lifecycle))),
    )

    expect(result.firstEvents.map((event) => event.sequence)).toEqual([1])
    expect(result.secondEvents.map((event) => event.sequence)).toEqual([1])
    expect(result.firstShutdown).toBe(true)
    expect(result.secondShutdown).toBe(true)
    expect(result.removed).toBe(2)
    expect(result.recreated).toBe(true)
  })
})

const collectOne = (created: Deferred.Deferred<void>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fiber = yield* ThreadLive.subscribe({ thread_id: threadId }).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Deferred.await(created)
      yield* ThreadLive.publish(threadCreated(1))
      return yield* Fiber.join(fiber)
    }),
  )

const threadLiveLayer = (lifecycle: ThreadLive.TopicLifecycle) => {
  const redactorLayer = SecretRedactor.layer
  const storageLayer = Layer.mergeAll(
    Database.memoryLayer,
    Migration.layer,
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  return ThreadLive.layerWithTopicLifecycle(lifecycle).pipe(Layer.provideMerge(migratedStorageLayer))
}

const threadCreated = (sequence: number): Event.ThreadCreated => ({
  id: Ids.EventId.make(`thread_live_topic_cleanup_event_${sequence}`),
  thread_id: threadId,
  sequence,
  version: 1,
  created_at: Common.TimestampMillis.make(2_020_000_000_000 + sequence),
  type: "thread.created",
  data: { workspace_id: workspaceId },
})
