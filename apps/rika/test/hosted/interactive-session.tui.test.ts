import { TextAttributes } from "@opentui/core"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "../support/tui-app.harness"
import { model } from "../support/tui-model.fixture"

const tuiTestTimeout = 90_000

const hasBoldText = (app: TuiApp.TuiApp, text: string): boolean =>
  app
    .spans()
    .lines.flatMap((line) => line.spans)
    .some((span) => span.text.includes(text) && (span.attributes & TextAttributes.BOLD) === TextAttributes.BOLD)

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

        yield* Effect.tryPromise(() => app.type("LIVE_ACTIVITY_PROMPT"))
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

test(
  "styles Markdown before the streamed answer completes",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [
            model.turn(
              [
                model.part("Plain intro"),
                model.part("\n\n**LIVE_MARKDOWN_STYLED**\n\n"),
                model.part("LIVE_MARKDOWN_FINAL"),
              ],
              // Each part must stay on screen long enough for the mid-stream assertion to see it.
              // The frame waits poll, so the pace only has to exceed a render, not a fixed guess.
              { streamPartDelayMillis: 400 },
            ),
          ],
        })

        yield* Effect.tryPromise(() => app.type("Stream styled Markdown."))
        app.pressEnter()

        const live = yield* app.waitFrame("LIVE_MARKDOWN_STYLED", 30_000)
        expect(live).toContain("Streaming")
        expect(live).not.toContain("LIVE_MARKDOWN_FINAL")
        expect(live).not.toContain("**LIVE_MARKDOWN_STYLED**")
        expect(hasBoldText(app, "LIVE_MARKDOWN_STYLED")).toBe(true)

        yield* app.waitFrame("LIVE_MARKDOWN_FINAL", 30_000)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "renders answer text beyond 4,096 UTF-16 code units before the model completes",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const beyondOldBoundary = `${"stream ".repeat(700)}\nLIVE_BEYOND_4096_BOUNDARY`
        const app = yield* TuiApp.tuiApp({
          script: [
            model.turn([model.part(beyondOldBoundary), model.part("\nLIVE_STREAM_FINAL_MARKER")], {
              streamPartDelayMillis: 400,
            }),
          ],
        })

        yield* Effect.tryPromise(() => app.type("Stream well beyond the old preview boundary."))
        app.pressEnter()

        const live = yield* app.waitFrame("LIVE_BEYOND_4096_BOUNDARY", 30_000)
        expect(live).toContain("Streaming")
        expect(live).not.toContain("LIVE_STREAM_FINAL_MARKER")

        yield* app.waitFrame("LIVE_STREAM_FINAL_MARKER", 30_000)
        yield* app.settled
        const completed = app.frame()
        expect(completed.match(/LIVE_BEYOND_4096_BOUNDARY/g) ?? []).toHaveLength(1)
        expect(completed.match(/LIVE_STREAM_FINAL_MARKER/g) ?? []).toHaveLength(1)
        expect(completed).not.toContain("Execution failed")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "streams a later model call after a tool response",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [
            model.turn([
              model.binding(
                { module: "processes", operation: "start", input: { command: "printf TOOL_CONTINUATION_OK" } },
                "streaming-tool",
              ),
            ]),
            model.turn([model.part("SECOND_CALL_STREAMING"), model.part("\nSECOND_CALL_FINAL")], {
              streamPartDelayMillis: 400,
            }),
          ],
        })

        yield* Effect.tryPromise(() => app.type("Use a tool, then stream the answer."))
        app.pressEnter()

        const live = yield* app.waitFrame("SECOND_CALL_STREAMING", 30_000)
        expect(live).toContain("Streaming")
        expect(live).toContain("printf TOOL_CONTINUATION_OK")
        expect(live).not.toContain("SECOND_CALL_FINAL")

        yield* app.waitFrame("SECOND_CALL_FINAL", 30_000)
        yield* app.settled
        const completed = app.frame()
        expect(completed.match(/SECOND_CALL_STREAMING/g) ?? []).toHaveLength(1)
        expect(completed.match(/SECOND_CALL_FINAL/g) ?? []).toHaveLength(1)
        expect(completed).not.toContain("Execution failed")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
