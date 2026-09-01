import { TextAttributes } from "@opentui/core"
import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "../../support/tui-app.harness"
import { model } from "../../support/tui-model.fixture"

const tuiTestTimeout = 90_000 as const

const hasBoldText = (app: TuiApp.TuiApp, text: string): boolean =>
  app
    .spans()
    .lines.flatMap((line) => line.spans)
    .some((span) => span.text.includes(text) && (span.attributes & TextAttributes.BOLD) === TextAttributes.BOLD)

test(
  "increases estimated Thinking and Streaming tokens during a fresh turn",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          script: [
            model.turn(
              [
                model.reasoning("1234"),
                model.reasoning("56789012"),
                model.part("abcd"),
                model.part("efghijkl"),
                model.part("LIVE_STREAM_ANSWER_COMPLETE"),
              ],
              { streamPartDelayMillis: 250, outputTokens: 23 },
            ),
          ],
        })

        yield* Effect.tryPromise(() => app.type("LIVE_ACTIVITY_PROMPT"))
        app.pressEnter()
        yield* app.waitFrame("LIVE_ACTIVITY_PROMPT")

        // Reasoning previews arrive before any durable answer unit; the estimate must visibly increase.
        const thinkingOne = yield* app.waitFrame("Thinking ~1 tok", 30_000)
        expect(thinkingOne).toContain("LIVE_ACTIVITY_PROMPT")
        expect(thinkingOne).not.toContain("Execution failed")
        const thinkingThree = yield* app.waitFrame("Thinking ~3 tok", 30_000)
        expect(thinkingThree).toContain("LIVE_ACTIVITY_PROMPT")

        // Answer text has its own counter and must also increase before the durable unit lands.
        const streamingOne = yield* app.waitFrame("Streaming ~1 tok", 30_000)
        expect(streamingOne).toContain("LIVE_ACTIVITY_PROMPT")
        expect(streamingOne).not.toContain("Execution failed")
        const streamingThree = yield* app.waitFrame("Streaming ~3 tok", 30_000)
        expect(streamingThree).toContain("LIVE_ACTIVITY_PROMPT")

        // The durable answer lands exactly once and the echoed prompt is never duplicated.
        const completed = yield* app.waitFrame("LIVE_STREAM_ANSWER_COMPLETE", 30_000)
        expect(completed.match(/LIVE_ACTIVITY_PROMPT/g) ?? []).toHaveLength(1)
        expect(completed.match(/LIVE_STREAM_ANSWER_COMPLETE/g) ?? []).toHaveLength(1)
        expect(completed).not.toContain("Execution failed")
        const durable = yield* app.waitTranscript(
          Turn.TurnId.make("tui-turn-0"),
          (projection) => projection.state.usage.tokens?.output.text === 23,
        )
        expect(durable.state.usage.tokens?.output).toMatchObject({ total: 23, text: 23 })
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
            model.turn(
              [
                model.reasoning("FIRST_CALL_REASONING"),
                model.binding(
                  { module: "processes", operation: "start", input: { command: "printf THINKING_COUNT_OK" } },
                  "thinking-tool",
                ),
              ],
              { streamPartDelayMillis: 250, outputTokens: 7, outputReasoningTokens: 7 },
            ),
            model.turn(
              [
                model.part("FIRST_CALL_STREAMED"),
                model.binding(
                  { module: "processes", operation: "start", input: { command: "printf TOOL_CONTINUATION_OK" } },
                  "streaming-tool",
                ),
              ],
              { delayMillis: 2_000, streamPartDelayMillis: 250, outputTokens: 5, outputTextTokens: 5 },
            ),
            model.turn([model.part("SECOND_CALL_STREAMING"), model.part("\nSECOND_CALL_FINAL")], {
              delayMillis: 2_000,
              streamPartDelayMillis: 400,
            }),
          ],
        })

        yield* Effect.tryPromise(() => app.type("Use a tool, then stream the answer."))
        app.pressEnter()

        const thought = yield* app.waitFrame("Thinking ~5 tok", 30_000)
        expect(thought).toContain("Use a tool, then stream the answer.")
        expect(thought).not.toContain("Execution failed")
        yield* app.waitFrame("printf THINKING_COUNT_OK", 30_000)

        const counted = yield* app.waitFrame("Streaming ~5 tok", 30_000)
        expect(counted).toContain("FIRST_CALL_STREAMED")

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
