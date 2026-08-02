import * as Turn from "@rika/product/turn-record"
import { Deferred, Effect, Schema } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const waitForDurableChildOutput = Effect.fn("TuiApp.waitForDurableChildOutput")(function* (
  app: TuiApp.TuiApp,
  turnId: Turn.TurnId,
) {
  const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  for (;;) {
    const projection = yield* app.transcript(turnId)
    const encodedUnits =
      projection === undefined ? undefined : yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(projection.units)
    if (
      projection !== undefined &&
      projection.executionCheckpoints.length === 2 &&
      projection.executionCheckpoints.every((checkpoint) => checkpoint.status === "completed") &&
      encodedUnits !== undefined &&
      encodedUnits.includes("CHILD_STREAMED_BEFORE_ROOT")
    )
      return projection
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    if (now - started >= 5_000) return yield* Effect.die("child output was not durably persisted")
    yield* Effect.sleep("20 millis")
  }
})

test(
  "streams child progress before the root execution completes",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          workspaceFiles: { "live-child.txt": "LIVE_CHILD_FILE" },
          lanes: [
            {
              script: [
                model.toolCall("task", { prompt: "Inspect the live child fixture." }, "live-child"),
                model.toolCall("await_subagents", {}, "live-join"),
                model.text("ROOT_FINISHED_AFTER_CHILD_STREAM", 2_000),
              ],
            },
            {
              when: (prompt) => !prompt.includes("Verify live child streaming."),
              script: [
                model.toolCall("read", { path: "live-child.txt" }, "live-read"),
                model.turn([
                  model.part("CHILD_STREAMED_BEFORE_ROOT"),
                  model.toolCall("bash", { command: "sleep 3" }, "live-child-hold"),
                ]),
                model.text("CHILD_FINISHED_AFTER_HOLD"),
              ],
            },
          ],
        })

        yield* Effect.promise(() => app.type("Verify live child streaming."))
        app.pressEnter()
        yield* app.waitFrame("Subagent working")
        app.pressKey("\t")
        app.pressEnter()
        const firstVisible = yield* app.waitFrame("CHILD_STREAMED_BEFORE_ROOT", 3_000)
        expect(firstVisible).not.toContain("ROOT_FINISHED_AFTER_CHILD_STREAM")

        yield* Effect.sleep("750 millis")
        const live = yield* app.waitFrameMatch(
          (frame) => frame.includes("CHILD_STREAMED_BEFORE_ROOT") && frame.includes("Subagent working"),
          2_000,
        )
        expect(live).not.toContain("CHILD_FINISHED_AFTER_HOLD")
        expect(live).not.toContain("ROOT_FINISHED_AFTER_CHILD_STREAM")
        expect(live).not.toContain("Execution failed")

        yield* app.waitFrame("CHILD_FINISHED_AFTER_HOLD")
        yield* app.waitFrame("ROOT_FINISHED_AFTER_CHILD_STREAM")

        const turnId = Turn.TurnId.make("tui-turn-0")
        const durable = yield* waitForDurableChildOutput(app, turnId)
        expect(durable.executionCheckpoints.some((checkpoint) => checkpoint.attachment !== undefined)).toBe(true)

        yield* Effect.sleep("300 millis")
        const finalFrame = yield* app.waitFrame("ROOT_FINISHED_AFTER_CHILD_STREAM", 1_000)
        expect(finalFrame).not.toContain("Execution failed")

        let exited = false
        for (let attempt = 0; attempt < 3 && !exited; attempt += 1) {
          app.close()
          exited = yield* app.done.pipe(
            Effect.as(true),
            Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(false) }),
          )
        }
        expect(exited).toBe(true)
      }),
    ),
  240_000,
)

test(
  "settles activity before a held child projection follower drains",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const hold = yield* Deferred.make<void>()
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          holdExecutionFollows: hold,
          lanes: [
            {
              script: [
                model.toolCall("task", { prompt: "Held child prompt" }, "held-child"),
                model.toolCall("await_subagents", {}, "held-child-join"),
                model.text("ROOT_SETTLED_BEFORE_CHILD_PROJECTION"),
              ],
            },
            {
              when: (prompt) => !prompt.includes("Hold child projection after root completion."),
              script: [model.text("CHILD_STREAMED_BEFORE_ROOT")],
            },
          ],
        })

        yield* Effect.promise(() => app.type("Hold child projection after root completion."))
        app.pressEnter()
        yield* app.waitFrame("Subagent working")
        app.pressKey("\t")
        app.pressEnter()
        yield* app.waitFrame("ROOT_SETTLED_BEFORE_CHILD_PROJECTION")
        const settled = yield* app.settled
        for (const marker of ["Waiting", "Streaming", "Thinking", "Sending", "Running 1 subagent"])
          expect(settled).not.toContain(marker)

        const rootId = Turn.TurnId.make("tui-turn-0")
        const open = yield* app.transcript(rootId)
        expect(open?.executionCheckpoints.some((checkpoint) => checkpoint.executionKey !== String(rootId))).toBe(true)
        expect(open?.executionCheckpoints.some((checkpoint) => checkpoint.status !== "completed")).toBe(true)

        yield* Deferred.succeed(hold, undefined)
        const durable = yield* waitForDurableChildOutput(app, rootId)
        expect(durable.executionCheckpoints.every((checkpoint) => checkpoint.status === "completed")).toBe(true)
        const final = yield* app.settled
        for (const marker of ["Waiting", "Streaming", "Thinking", "Sending", "Running 1 subagent"])
          expect(final).not.toContain(marker)
        yield* app.quit
      }),
    ),
  240_000,
)
