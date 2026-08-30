import { Clock, Effect } from "effect"
import type { Prompt } from "effect/unstable/ai"
import * as Thread from "@rika/product/thread-record"
import type * as TuiApp from "../../../support/tui-app.harness"

const promptTexts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) => {
    if (message.role === "user") return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
    return []
  })

type QueueSnapshot = Effect.Success<ReturnType<TuiApp.TuiApp["queue"]>>

const waitQueue = (
  app: TuiApp.TuiApp,
  threadId: Thread.ThreadId,
  predicate: (queue: QueueSnapshot) => boolean,
  budgetMillis = 20_000,
): Effect.Effect<QueueSnapshot, never> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    for (;;) {
      const queue = yield* app.queue(threadId).pipe(Effect.orDie)
      if (predicate(queue)) return queue
      const now = yield* Clock.currentTimeMillis
      if (now - started >= budgetMillis)
        return yield* Effect.die(
          `queue condition was not met: ${queue.turns.map((turn) => String(turn.id)).join(", ")}`,
        )
      yield* Effect.sleep("10 millis")
    }
  })

const selectQueue = (app: TuiApp.TuiApp, prompts: ReadonlyArray<string>, target: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < prompts.length + 2; attempt += 1) {
      const lines = (yield* app.nextFrame).split("\n")
      const selected = prompts.findIndex((prompt) =>
        lines.some((line) => line.includes(prompt) && line.includes("Backspace to dequeue")),
      )
      if (selected === target) return
      app.pressArrow(selected < 0 || selected > target ? "up" : "down")
    }
    return yield* Effect.die(`could not select ${prompts[target]}`)
  })

export const contextFixture = { promptTexts, selectQueue, waitQueue }
