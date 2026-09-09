import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import { TestModel } from "generalist/testing"
import * as TuiApp from "../../support/tui-app.harness"
import { model } from "../../support/tui-model.fixture"

/** Exercises process-result folding through the hosted feed projection. */
const tuiTestTimeout = 60_000

test(
  "settles repeated process waits on the launching bash tool",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        /**
         * The immediate wait must observe a live process and the final wait must outlast it, so
         * these two numbers move together. A second was short enough that a loaded machine saw the
         * process already gone, and raising it alone pushed the finish past the final wait.
         */
        const command = "printf EARLY_OUTPUT; sleep 5; printf FINAL_OUTPUT"
        let processId = ""
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              resolveToolCallParams: (name, params, prompt) =>
                Effect.gen(function* () {
                  if (name !== "shell_command_status") return params
                  const receipt = prompt.content
                    .flatMap((message) =>
                      message.role === "tool"
                        ? message.content.flatMap((part) =>
                            part.type === "tool-result" && part.id === "bash-wait" ? [part.result] : [],
                          )
                        : [],
                    )
                    .at(-1)
                  const result = yield* Schema.decodeUnknownEffect(Schema.Struct({ processId: Schema.String }))(receipt)
                  const status = yield* Schema.decodeUnknownEffect(Schema.Struct({ waitMillis: Schema.Finite }))(params)
                  processId = result.processId
                  return { ...status, processId }
                }).pipe(Effect.orDie),
              steps: [
                model.turn([model.tool("bash", { command, timeout_ms: 0 }, "bash-wait")]),
                model.turn([
                  model.tool("shell_command_status", { processId: "launch-receipt", waitMillis: 0 }, "wait-immediate"),
                ]),
                model.turn([
                  model.tool("shell_command_status", { processId: "launch-receipt", waitMillis: 10_000 }, "wait-final"),
                ]),
                model.text("SHELL_WAIT_COMPLETE"),
              ],
            },
          ],
        })

        yield* Effect.tryPromise(() => app.type("Run the process and wait for it."))
        app.pressEnter()
        const running = yield* app.waitFrameMatch((frame) => frame.includes(`⇢ $ ${command}`), 20_000)
        expect(running).not.toContain("detached")

        yield* app.clickText(command)
        const expanded = yield* app.waitFrame("EARLY_OUTPUT")
        expect(expanded).toContain(`⇢ $ ${command}`)
        expect(expanded).not.toContain("detached")

        yield* app.clickText(command)
        const recollapsed = yield* app.waitFrame(`⇢ $ ${command}`)
        expect(recollapsed).not.toContain("detached")
        yield* app.waitFrame("SHELL_WAIT_COMPLETE", 20_000)
        const settled = yield* app.settled
        expect(settled).toContain(`✓ $ ${command}`)
        expect(settled).not.toContain("⇢")
        expect(settled).not.toContain("detached")

        const tools = (yield* app.transcript(Turn.TurnId.make("tui-turn-0")))?.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "ToolCall" ? [unit.content.block] : [],
        )
        expect(tools).toHaveLength(1)
        const bash = tools?.[0]
        expect(processId).not.toBe("")
        expect(bash).toMatchObject({
          name: "bash",
          status: "complete",
          process: {
            processId,
            running: false,
            exitCode: 0,
            command,
            background: true,
            checks: [
              { toolCallId: "wait-immediate", processId, waitMillis: 0 },
              { toolCallId: "wait-final", processId, waitMillis: 10_000 },
            ],
          },
        })
        const completedResult = yield* Schema.decodeUnknownEffect(Schema.Struct({ text: Schema.String }))(
          bash?.result,
        ).pipe(Effect.orDie)
        expect(completedResult.text).toContain("FINAL_OUTPUT")

        app.pressKey("\t")
        app.pressEnter()
        const completed = yield* app.waitFrame("FINAL_OUTPUT", 20_000)
        expect(completed).not.toContain("Waited for")
        expect(completed).not.toContain("Waiting for")
        expect(completed.split(command).length - 1).toBeLessThanOrEqual(1)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "receives a background child-group receipt without blocking on the child",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              steps: [
                model.turn([
                  TestModel.toolCall(
                    "start_child_group",
                    {
                      members: [{ key: "background", selection: "Task", prompt: "BACKGROUND_CHILD_PROMPT" }],
                      concurrency: 1,
                    },
                    { id: "start-background-child" },
                  ),
                ]),
                model.text("BACKGROUND_RECEIPT_OBSERVED"),
              ],
            },
            { profile: "Task", steps: [model.text("BACKGROUND_CHILD_DONE", 3_000)] },
          ],
          height: 40,
        })

        yield* Effect.tryPromise(() => app.type("Start independent child work."))
        app.pressEnter()
        const receipt = yield* app.waitFrameMatch(
          (frame) => frame.includes("BACKGROUND_RECEIPT_OBSERVED") && frame.includes("Running 1 subagent"),
          20_000,
        )
        expect(receipt).not.toContain("BACKGROUND_CHILD_DONE")

        yield* app.waitFrame("1 agent finished", 20_000)
        yield* app.clickText("1 agent finished")
        yield* app.waitFrame("Subagent finished")
        yield* app.clickText("Subagent finished")
        yield* app.waitFrame("BACKGROUND_CHILD_DONE")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
