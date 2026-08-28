import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect } from "effect"
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
  "settles repeated process waits while the launching cell owns process liveness",
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
            model.turn([
              model.binding(
                { module: "processes", operation: "start", input: { command, timeoutMillis: 0 } },
                "bash-wait",
              ),
            ]),
            model.turn([
              model.binding(
                { module: "processes", operation: "status", input: { processId: "1", waitMillis: 0 } },
                "wait-immediate",
              ),
            ]),
            model.turn([
              model.binding(
                { module: "processes", operation: "status", input: { processId: "1", waitMillis: 10_000 } },
                "wait-final",
              ),
            ]),
            model.text("SHELL_WAIT_COMPLETE"),
          ],
        })

        yield* Effect.tryPromise(() => app.type("Run the process and wait for it."))
        app.pressEnter()
        const running = yield* app.waitFrame('"waitMillis":10000', 20_000)
        const collapsedGlyph = spinnerFor(running, '"waitMillis":10000')
        expect(collapsedGlyph).toBeDefined()
        yield* app.waitFrameMatch((frame) => spinnerChanged(frame, '"waitMillis":10000', collapsedGlyph), 5_000)

        yield* app.clickText('"waitMillis":10000')
        const expanded = yield* app.waitFrame('"waitMillis":10000')
        const expandedGlyph = spinnerFor(expanded, '"waitMillis":10000')
        expect(expandedGlyph).toBeDefined()
        yield* app.waitFrameMatch((frame) => spinnerChanged(frame, '"waitMillis":10000', expandedGlyph), 5_000)

        yield* app.clickText('"waitMillis":10000')
        const recollapsed = yield* app.waitFrame('"waitMillis":10000')
        const recollapsedGlyph = spinnerFor(recollapsed, '"waitMillis":10000')
        expect(recollapsedGlyph).toBeDefined()
        yield* app.waitFrameMatch((frame) => spinnerChanged(frame, '"waitMillis":10000', recollapsedGlyph), 5_000)
        yield* app.waitFrame("SHELL_WAIT_COMPLETE", 20_000)
        yield* app.settled

        const cells = (yield* app.transcript(Turn.TurnId.make("tui-turn-0")))?.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "Cell" ? [unit.content.block] : [],
        )
        expect(cells?.map(({ source }) => source.text)).toEqual([
          `await rika.processes.start({ command: "${command}", timeoutMillis: 0 })\n`,
          'await rika.processes.status({ processId: "1", waitMillis: 0 })\n',
          'await rika.processes.status({ processId: "1", waitMillis: 10000 })\n',
        ])
        expect(cells?.at(0)?.result).toMatchObject({ processId: "1", running: true })
        expect(cells?.at(1)?.result).toMatchObject({ running: true })
        expect(cells?.at(2)?.result).toMatchObject({
          text: expect.stringContaining("FINAL_OUTPUT"),
          running: false,
          exitCode: 0,
        })
        expect(cells?.every(({ status }) => status === "complete")).toBe(true)

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
