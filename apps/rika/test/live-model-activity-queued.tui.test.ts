import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 90_000

test(
  "shows live Thinking and Streaming activity for a promoted queued turn",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [
            // Queueing the follow-up while the head answer is pending measures well under a
            // second, so the head is held with several times that margin.
            model.text("FIRST_QUEUE_HEAD", 2_000),
            model.turn([model.reasoning("Promoted reasoning trace."), model.part("PROMOTED_ANSWER_COMPLETE")], {
              streamPartDelayMillis: 250,
            }),
          ],
        })

        yield* Effect.tryPromise(() => app.type("Hold the queue head."))
        app.pressEnter()
        yield* app.waitFrame("Hold the queue head.")
        yield* Effect.tryPromise(() => app.type("Promote me after the head."))
        app.pressEnter()
        yield* app.waitFrame("Promote me after the head.")
        yield* app.waitModelRequests(1)

        // Cancel the head; the queued turn promotes through pending-turn-promotion and must stream live.
        app.pressKey("c", { ctrl: true })
        const thinking = yield* app.waitFrame("Thinking", 30_000)
        expect(thinking).toContain("Promote me after the head.")
        expect(thinking).toMatch(/Thinking \d+ tok/)
        expect(thinking).not.toContain("Execution failed")

        const streaming = yield* app.waitFrame("Streaming", 30_000)
        expect(streaming).toContain("Promote me after the head.")
        expect(streaming).toMatch(/Streaming \d+ tok/)
        expect(streaming).not.toContain("Execution failed")

        const completed = yield* app.waitFrame("PROMOTED_ANSWER_COMPLETE", 30_000)
        expect(completed.match(/Promote me after the head\./g) ?? []).toHaveLength(1)
        expect(completed).not.toContain("Execution failed")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
