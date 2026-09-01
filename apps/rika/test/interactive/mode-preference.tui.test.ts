import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect, Schema } from "effect"
import * as TuiApp from "../support/tui-app.harness"
import { model } from "../support/tui-model.fixture"

const tuiTestTimeout = 60_000
const spinnerFor = (frame: string, marker: string): string | undefined => {
  const lines = frame.split("\n")
  const sourceLine = lines.findIndex((line) => line.includes(marker))
  if (sourceLine < 0) return undefined
  return lines[sourceLine]?.match(/[⠀-⣿]/u)?.[0] ?? lines[sourceLine - 1]?.match(/[⠀-⣿]/u)?.[0]
}
const spinnerChanged = (frame: string, marker: string, previous: string | undefined): boolean => {
  const current = spinnerFor(frame, marker)
  return current !== undefined && current !== previous
}

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
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          script: [
            model.turn([model.tool("bash", { command, timeout_ms: 0 }, "bash-wait")]),
            model.turn([model.tool("shell_command_status", { processId: "1", waitMillis: 0 }, "wait-immediate")]),
            model.turn([model.tool("shell_command_status", { processId: "1", waitMillis: 10_000 }, "wait-final")]),
            model.text("SHELL_WAIT_COMPLETE"),
          ],
        })

        yield* Effect.tryPromise(() => app.type("Run the process and wait for it."))
        app.pressEnter()
        const running = yield* app.waitFrameMatch(
          (frame) => frame.includes("process 1 · detached") && spinnerFor(frame, command) !== undefined,
          20_000,
        )
        const collapsedGlyph = spinnerFor(running, command)
        expect(collapsedGlyph).toBeDefined()
        yield* app.waitFrameMatch((frame) => spinnerChanged(frame, command, collapsedGlyph), 5_000)

        yield* app.clickText(command)
        const expanded = yield* app.waitFrame("EARLY_OUTPUT")
        const expandedGlyph = spinnerFor(expanded, command)
        expect(expandedGlyph).toBeDefined()
        yield* app.waitFrameMatch((frame) => spinnerChanged(frame, command, expandedGlyph), 5_000)

        yield* app.clickText(command)
        const recollapsed = yield* app.waitFrame("process 1 · detached")
        const recollapsedGlyph = spinnerFor(recollapsed, command)
        expect(recollapsedGlyph).toBeDefined()
        yield* app.waitFrameMatch((frame) => spinnerChanged(frame, command, recollapsedGlyph), 5_000)
        yield* app.waitFrame("SHELL_WAIT_COMPLETE", 20_000)
        yield* app.settled

        const tools = (yield* app.transcript(Turn.TurnId.make("tui-turn-0")))?.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "ToolCall" ? [unit.content.block] : [],
        )
        expect(tools).toHaveLength(1)
        const bash = tools?.[0]
        expect(bash).toMatchObject({
          name: "bash",
          status: "complete",
          process: {
            processId: "1",
            running: false,
            exitCode: 0,
            command,
            background: true,
            checks: [
              { toolCallId: "wait-immediate", processId: "1", waitMillis: 0 },
              { toolCallId: "wait-final", processId: "1", waitMillis: 10_000 },
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
