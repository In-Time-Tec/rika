import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 90_000

test(
  "shows live Thinking and Streaming activity for a fresh turn with the prompt always visible",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [
            model.turn(
              [model.reasoning("Working through the reasoning trace."), model.part("LIVE_STREAM_ANSWER_COMPLETE")],
              { streamPartDelayMillis: 250 },
            ),
          ],
        })

        yield* Effect.promise(() => app.type("LIVE_ACTIVITY_PROMPT"))
        app.pressEnter()
        yield* app.waitFrame("LIVE_ACTIVITY_PROMPT")

        // Reasoning previews arrive before any durable answer unit; the footer must say Thinking.
        const thinking = yield* app.waitFrame("Thinking", 30_000)
        expect(thinking).toContain("LIVE_ACTIVITY_PROMPT")
        expect(thinking).toMatch(/Thinking \d+ tok/)
        expect(thinking).not.toContain("Execution failed")

        // Once answer text streams, the footer must switch to Streaming before the durable unit lands.
        const streaming = yield* app.waitFrame("Streaming", 30_000)
        expect(streaming).toContain("LIVE_ACTIVITY_PROMPT")
        expect(streaming).toMatch(/Streaming \d+ tok/)
        expect(streaming).not.toContain("Execution failed")

        // The durable answer lands exactly once and the echoed prompt is never duplicated.
        const completed = yield* app.waitFrame("LIVE_STREAM_ANSWER_COMPLETE", 30_000)
        expect(completed.match(/LIVE_ACTIVITY_PROMPT/g) ?? []).toHaveLength(1)
        expect(completed.match(/LIVE_STREAM_ANSWER_COMPLETE/g) ?? []).toHaveLength(1)
        expect(completed).not.toContain("Execution failed")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
