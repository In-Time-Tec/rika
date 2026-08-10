import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000

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
                { module: "processes", operation: "status", input: { processId: "1", waitMillis: 25_000 } },
                "wait-final",
              ),
            ]),
            model.text("SHELL_WAIT_COMPLETE"),
          ],
        })

        yield* Effect.promise(() => app.type("Run the process and wait for it."))
        app.pressEnter()
        yield* app.waitFrame("SHELL_WAIT_COMPLETE", 20_000)
        yield* app.settled

        const cells = (yield* app.transcript(Turn.TurnId.make("tui-turn-0")))?.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "Cell" ? [unit.content.block] : [],
        )
        expect(cells?.map(({ source }) => source.text)).toEqual([
          `await rika.processes.start({"command":"${command}","timeoutMillis":0})`,
          'await rika.processes.status({"processId":"1","waitMillis":0})',
          'await rika.processes.status({"processId":"1","waitMillis":25000})',
        ])
        expect(cells?.at(0)?.result, "the launching cell reports the registered process").toContain('processId: "1"')
        expect(cells?.at(0)?.result, "the launching cell leaves the process running").toContain("running: true")
        expect(cells?.at(1)?.result).toContain("EARLY_OUTPUT")
        expect(cells?.at(1)?.result, "the immediate wait observes a live process").toContain("running: true")
        expect(cells?.at(2)?.result).toContain("FINAL_OUTPUT")
        expect(cells?.at(2)?.result, "the final wait observes a settled process").toContain("running: false")
        expect(cells?.at(2)?.result, "the settled process reports its exit code").toContain("exitCode: 0")
        expect(cells?.every(({ status }) => status === "complete")).toBe(true)

        app.pressKey("\t")
        app.pressEnter()
        const completed = yield* app.waitFrame("FINAL_OUTPUT", 20_000)
        expect(completed).not.toContain("Waited for")
        expect(completed).not.toContain("Waiting for")
        // The one expanded cell shows its own source and its result, and the result of a started
        // process echoes the command back, so the command it launched appears in both.
        expect(completed.split(command).length - 1).toBe(2)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
