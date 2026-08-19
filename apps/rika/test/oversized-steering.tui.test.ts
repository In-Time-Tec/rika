import { Effect } from "effect"
import { expect, test } from "vitest"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as Thread from "@rika/product/thread-record"
import * as Turn from "@rika/product/turn-record"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

type QueueSnapshot = Effect.Success<ReturnType<TuiApp.TuiApp["queue"]>>

const waitQueue = (
  app: TuiApp.TuiApp,
  threadId: Thread.ThreadId,
  predicate: (queue: QueueSnapshot) => boolean,
  budgetMillis = 60_000,
): Effect.Effect<QueueSnapshot, never> =>
  Effect.flatMap(
    Effect.clockWith((clock) => clock.currentTimeMillis),
    (start) => {
      const poll = (): Effect.Effect<QueueSnapshot, never> =>
        app.queue(threadId).pipe(
          Effect.flatMap((queue) =>
            Effect.flatMap(
              Effect.clockWith((clock) => clock.currentTimeMillis),
              (now) =>
                predicate(queue) || now - start >= budgetMillis
                  ? Effect.succeed(queue)
                  : Effect.sleep("50 millis").pipe(Effect.andThen(poll())),
            ),
          ),
          Effect.orDie,
        )
      return poll()
    },
  )

/**
 * A prompt typed while a turn runs is queued, and steering that row sends its text to the running
 * turn. A queued prompt carries no size bound of its own, so a long one — a pasted stack trace, a
 * file, a diff — always exceeded the composer's 4096-character convenience limit. Enforcing that
 * limit on delivery consumed the queued row and delivered nothing, so the steer vanished with no
 * pending entry, no settled entry, and no report. Baton bounds a steering prompt by the same
 * message limits as any other prompt, and the projection stopped enforcing this number when it
 * stopped throwing on oversized internal steers.
 */
test(
  "delivers a steer whose text exceeds the composer convenience limit",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const threadId = Thread.ThreadId.make("tui-thread-0")
        const activeTurnId = Turn.TurnId.make("tui-turn-0")
        const app = yield* TuiApp.tuiApp({
          height: 36,
          inspectTranscript: true,
          script: [model.text("ACTIVE_COMPLETE", 4_000), model.text("FOLLOW_UP_COMPLETE")],
        })

        yield* Effect.promise(() => app.type("Begin steerable work"))
        app.pressEnter()
        yield* app.waitModelRequests(1)

        const oversized = `OVERSIZE${"z".repeat(ExecutionGateway.SteeringTextMaxCharacters)}`
        yield* Effect.promise(() => app.paste(oversized))
        app.pressEnter()
        yield* waitQueue(app, threadId, (queue) => queue.turns.some((turn) => turn.prompt.startsWith("OVERSIZE")))

        app.pressArrow("up")
        yield* Effect.sleep("500 millis")
        app.pressEnter()

        const waitSteered = (budgetMillis: number): Effect.Effect<number, never> =>
          Effect.gen(function* () {
            const started = performance.now()
            for (;;) {
              const projection = yield* app.transcript(activeTurnId).pipe(Effect.orDie)
              const steering = projection?.state.steering
              const count = (steering?.pending?.length ?? 0) + (steering?.settled?.length ?? 0)
              if (count > 0 || performance.now() - started >= budgetMillis) return count
              yield* Effect.sleep("100 millis")
            }
          })
        expect(yield* waitSteered(60_000)).toBeGreaterThan(0)
        yield* app.waitFrame("ACTIVE_COMPLETE", 15_000)
        yield* app.settled
        yield* app.quit
      }),
    ),
  180_000,
)
