import { describe, expect, test } from "bun:test"
import { Time } from "@rika/core"
import { Common, Ids } from "@rika/schema"
import { Effect, Layer, Stream } from "effect"
import { PresenceHub } from "../src/index"

const now = Common.TimestampMillis.make(2_040_000_000_000)
const threadId = Ids.ThreadId.make("thread_presence_concurrent")
const firstUserId = Ids.UserId.make("user_presence_first")
const secondUserId = Ids.UserId.make("user_presence_second")

describe("PresenceHub", () => {
  test("concurrent heartbeats for one thread share the same presence state", async () => {
    const frame = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.all(
            [
              PresenceHub.heartbeat({ thread_id: threadId, user_id: firstUserId, state: "active" }),
              PresenceHub.heartbeat({ thread_id: threadId, user_id: secondUserId, state: "typing" }),
            ],
            { concurrency: "unbounded" },
          )
          const frames = yield* PresenceHub.subscribe(threadId).pipe(Stream.take(1), Stream.runCollect)
          return Array.from(frames)[0]
        }),
      ).pipe(Effect.provide(PresenceHub.layer.pipe(Layer.provideMerge(Time.fixedLayer(now))))),
    )

    expect(frame?.presence.users).toEqual([
      { user_id: firstUserId, state: "active", last_seen: now },
      { user_id: secondUserId, state: "typing", last_seen: now },
    ])
  })
})
