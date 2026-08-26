import { expect, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { makeThreadProtocolNotifications } from "../../../src/hosted/thread/notifications"

it.effect("wakes only the changed Thread and uses recovery to sweep every waiter", () =>
  Effect.gen(function* () {
    const notifications = makeThreadProtocolNotifications()
    const first = yield* notifications.wait("thread-1", notifications.generation("thread-1")).pipe(Effect.forkChild)
    const second = yield* notifications.wait("thread-2", notifications.generation("thread-2")).pipe(Effect.forkChild)
    notifications.publish("thread-1")
    expect(yield* Fiber.join(first)).toEqual({ thread: 1, recovery: 0 })

    const firstAgain = yield* notifications
      .wait("thread-1", notifications.generation("thread-1"))
      .pipe(Effect.forkChild)
    notifications.recover()
    expect(yield* Fiber.join(firstAgain)).toEqual({ thread: 0, recovery: 1 })
    expect(yield* Fiber.join(second)).toEqual({ thread: 0, recovery: 1 })
    expect(notifications.generation("thread-1")).toEqual({ thread: 0, recovery: 1 })
  }),
)
