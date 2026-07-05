import { describe, expect, test } from "bun:test"
import { Time } from "@rika/core"
import { Common, Ids, Remote } from "@rika/schema"
import { Clock, Deferred, Effect, Layer, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"
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

  test("expires stale presence entries from the sweep under TestClock", async () => {
    const collectedFrames = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* PresenceHub.heartbeat({ thread_id: threadId, user_id: firstUserId, state: "active" })
          const framesRef = yield* Ref.make<ReadonlyArray<Remote.PresenceFrame>>([])
          const firstFrame = yield* Deferred.make<void>()

          yield* PresenceHub.subscribe(threadId).pipe(
            Stream.take(2),
            Stream.runForEach((frame) =>
              Effect.gen(function* () {
                const next = [...(yield* Ref.get(framesRef)), frame]
                yield* Ref.set(framesRef, next)
                if (next.length === 1) yield* Deferred.succeed(firstFrame, undefined).pipe(Effect.ignore)
              }),
            ),
            Effect.forkScoped,
          )

          yield* Deferred.await(firstFrame)
          expect((yield* Ref.get(framesRef)).map((frame) => frame.presence.users)).toEqual([
            [{ user_id: firstUserId, state: "active", last_seen: Common.TimestampMillis.make(0) }],
          ])

          yield* TestClock.adjust("1 second")
          expect(yield* Ref.get(framesRef)).toHaveLength(1)

          yield* TestClock.adjust("45 seconds")
          yield* Effect.yieldNow
          expect(yield* Ref.get(framesRef)).toHaveLength(2)

          return yield* Ref.get(framesRef)
        }),
      ).pipe(
        Effect.provide(
          PresenceHub.layer.pipe(Layer.provideMerge(testClockTimeLayer), Layer.provideMerge(TestClock.layer())),
        ),
      ),
    )

    expect(collectedFrames[0]?.presence.users).toEqual([
      { user_id: firstUserId, state: "active", last_seen: Common.TimestampMillis.make(0) },
    ])
    expect(collectedFrames[1]?.presence.users).toEqual([])
  })
})

const testClockTimeLayer = Layer.effect(
  Time.Service,
  Effect.map(Clock.Clock, (clock) =>
    Time.Service.of({
      nowMillis: Effect.sync(() => Common.TimestampMillis.make(clock.currentTimeMillisUnsafe())),
    }),
  ),
)
