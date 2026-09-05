import { expect, it } from "@effect/vitest"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import { Deferred, Effect, Fiber } from "effect"
import { HostedError } from "../../../src/hosted/contract"
import * as H from "./harness"

it.effect("reports catalog failure and recovery without replacing titles, and ignores stale refresh outcomes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received: Array<InteractiveEvent> = []
      type Threads = Extract<InteractiveEvent, { _tag: "ThreadsListed" }>["threads"]
      let list: Effect.Effect<Threads, HostedError> = Effect.succeed([])
      const hosted = yield* H.runSession(
        H.makeHarness(H.fixtures.defaultReceive),
        (event) => received.push(event),
        () => Effect.die("unused"),
        Effect.suspend(() => list),
      )
      yield* H.eventually(() => received.some((event) => event._tag === "ThreadsListed"))
      received.length = 0
      const failed = HostedError.make({ kind: "network", message: "offline" })
      list = Effect.fail(failed)
      yield* hosted.session.refreshThreads
      expect(received).toEqual([
        { _tag: "ThreadsRefreshChanged", status: "loading" },
        { _tag: "ThreadsRefreshChanged", status: "failed" },
      ])
      for (const staleOutcome of [Effect.succeed([]), Effect.fail(failed)]) {
        const held = yield* Deferred.make<Threads, HostedError>()
        list = Deferred.await(held)
        const older = yield* hosted.session.refreshThreads.pipe(Effect.forkScoped)
        yield* H.eventually(() => {
          const event = received.at(-1)
          return event?._tag === "ThreadsRefreshChanged" && event.status === "loading"
        })
        list = Effect.succeed([])
        yield* hosted.session.refreshThreads
        expect(received.at(-1)).toEqual({ _tag: "ThreadsRefreshChanged", status: "idle" })
        const count = received.length
        yield* Deferred.complete(held, staleOutcome)
        yield* Fiber.join(older)
        expect(received).toHaveLength(count)
      }
      yield* hosted.session.quit
    }),
  ),
)
