import type { Projection } from "@rika/persistence/transcript-repository"
import * as Turn from "@rika/persistence/turn"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"

const hasDurableChildOutput = (projection: Projection) =>
  projection.units.some(
    (unit) => unit.content._tag === "Entry" && unit.content.text.includes("CHILD_STREAMED_BEFORE_ROOT"),
  )

const waitForDurableChildOutput = Effect.fn("TuiApp.waitForDurableChildOutput")(function* (
  app: TuiApp.TuiApp,
  turnId: Turn.TurnId,
) {
  const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  for (;;) {
    const projection = yield* app.transcript(turnId)
    if (
      projection !== undefined &&
      projection.executionCheckpoints.length === 2 &&
      projection.executionCheckpoints.every((checkpoint) => checkpoint.status === "completed") &&
      hasDurableChildOutput(projection)
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
                TuiApp.model.toolCall("task", { prompt: "Inspect the live child fixture." }, "live-child"),
                TuiApp.model.toolCall("await_subagents", {}, "live-join"),
                TuiApp.model.text("ROOT_FINISHED_AFTER_CHILD_STREAM", 2_000),
              ],
            },
            {
              when: (prompt) => !prompt.includes("Verify live child streaming."),
              script: [
                TuiApp.model.toolCall("read", { path: "live-child.txt" }, "live-read"),
                TuiApp.model.turn([
                  TuiApp.model.part("CHILD_STREAMED_BEFORE_ROOT"),
                  TuiApp.model.toolCall("bash", { command: "sleep 3" }, "live-child-hold"),
                ]),
                TuiApp.model.text("CHILD_FINISHED_AFTER_HOLD"),
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
  "keeps the transcript live through three parallel subagent waits",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              script: [
                TuiApp.model.toolCall("task", { prompt: "Parallel child A" }, "parallel-a"),
                TuiApp.model.toolCall("task", { prompt: "Parallel child B" }, "parallel-b"),
                TuiApp.model.toolCall("task", { prompt: "Parallel child C" }, "parallel-c"),
                TuiApp.model.toolCall("await_subagents", {}, "parallel-join"),
                TuiApp.model.text("PARALLEL_ROOT_FINISHED"),
              ],
            },
            {
              when: (prompt) =>
                !prompt.includes("Run three parallel subagents.") && prompt.includes("Parallel child A"),
              script: [
                TuiApp.model.turn([
                  TuiApp.model.part("PARALLEL_CHILD_A"),
                  TuiApp.model.toolCall("bash", { command: "sleep 1" }, "parallel-a-hold"),
                ]),
                TuiApp.model.text("PARALLEL_CHILD_A_DONE"),
              ],
            },
            {
              when: (prompt) =>
                !prompt.includes("Run three parallel subagents.") && prompt.includes("Parallel child B"),
              script: [
                TuiApp.model.turn([
                  TuiApp.model.part("PARALLEL_CHILD_B"),
                  TuiApp.model.toolCall("bash", { command: "sleep 1" }, "parallel-b-hold"),
                ]),
                TuiApp.model.text("PARALLEL_CHILD_B_DONE"),
              ],
            },
            {
              when: (prompt) =>
                !prompt.includes("Run three parallel subagents.") && prompt.includes("Parallel child C"),
              script: [
                TuiApp.model.turn([
                  TuiApp.model.part("PARALLEL_CHILD_C"),
                  TuiApp.model.toolCall("bash", { command: "sleep 1" }, "parallel-c-hold"),
                ]),
                TuiApp.model.text("PARALLEL_CHILD_C_DONE"),
              ],
            },
          ],
        })

        yield* Effect.promise(() => app.type("Run three parallel subagents."))
        app.pressEnter()
        yield* app.waitFrame("Subagent working")
        app.pressKey("\t")
        app.pressEnter()
        yield* app.waitFrame("PARALLEL_CHILD_A")
        const finished = yield* app.waitFrame("PARALLEL_ROOT_FINISHED")
        expect(finished).not.toContain("Execution failed")

        const projection = yield* app.transcript(Turn.TurnId.make("tui-turn-0"))
        expect(projection?.executionCheckpoints).toHaveLength(4)
        expect(projection?.executionCheckpoints.every((checkpoint) => checkpoint.status === "completed")).toBe(true)

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
