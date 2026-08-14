import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Queue } from "effect"
import { makeOutbound } from "../src/transport/client/server-client-outbound"

describe("server client outbound", () => {
  it.effect("sends control input before an already congested stream queue", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const written = yield* Queue.unbounded<string>()
      let first = true
      const outbound = yield* makeOutbound({
        capacity: 4,
        rawWriter: (frame) =>
          Effect.gen(function* () {
            if (first) {
              first = false
              yield* Deferred.succeed(started, undefined)
              yield* Deferred.await(release)
            }
            if (typeof frame === "string") yield* Queue.offer(written, frame)
          }),
      })
      const worker = yield* Effect.forkChild(outbound.run)
      yield* outbound.write("stream-1")
      yield* Deferred.await(started)
      yield* Effect.forEach(["stream-2", "stream-3", "stream-4", "stream-5"], outbound.write, { discard: true })
      yield* outbound.writeExpress("approve")
      yield* outbound.writeExpress("cancel")
      yield* Deferred.succeed(release, undefined)

      expect(yield* Effect.forEach(Array.from({ length: 7 }), () => Queue.take(written))).toEqual([
        "stream-1",
        "approve",
        "cancel",
        "stream-2",
        "stream-3",
        "stream-4",
        "stream-5",
      ])
      yield* Fiber.interrupt(worker)
    }),
  )
})
