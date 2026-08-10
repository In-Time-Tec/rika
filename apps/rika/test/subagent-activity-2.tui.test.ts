import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000
test(
  "shows a running cell as running work on the activity line",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        // The activity line is the only thing telling a reader a cell is still working. Every gate
        // we run reads a model or a projection, so a client that computes the line correctly and
        // never renders it stays green everywhere; this reads the frame a user sees.
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "slow.txt": "SLOW_BODY" },
          script: [
            model.turn([
              model.binding(
                { module: "processes", operation: "start", input: { command: "sleep 2", timeoutMillis: 8_000 } },
                "slow-cell",
              ),
            ]),
            model.text("ACTIVITY_LANE_COMPLETE"),
          ],
        })

        yield* Effect.promise(() => app.type("Run something slow."))
        app.pressEnter()
        const running = yield* app.waitFrame("Running", 20_000)
        expect(running).toContain("Running 1 tool")
        yield* app.waitFrame("ACTIVITY_LANE_COMPLETE", 25_000)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "returns the activity line to idle once every child has finished",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        // Every lane here proves the counter goes up. A reader also needs it to come down: a line
        // that still says a subagent is running after one finished describes work nobody is doing.
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Oracle", prompt: "IDLE_CHILD_PROMPT" }], "idle-agent")]),
                model.text("IDLE_ROOT_DONE"),
                // A child that settles after the root answer resumes this same Run once more.
                model.text("IDLE_SETTLEMENT_ACKNOWLEDGED"),
                model.text("IDLE_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            { profile: "Oracle", steps: [model.text("IDLE_CHILD_DONE")] },
          ],
          height: 40,
        })

        yield* Effect.promise(() => app.type("Delegate once."))
        app.pressEnter()
        const root = yield* app.waitFrameMatch(
          (frame) => frame.includes("IDLE_ROOT_DONE") || frame.includes("Execution failed"),
          25_000,
        )
        expect(root, `Root model requests: ${yield* app.modelRequestCount}`).not.toContain("Execution failed")
        expect(root).toContain("IDLE_ROOT_DONE")
        const settled = yield* app.waitFrameMatch(
          (frame) => frame.includes("Oracle has spoken") || frame.includes("Execution failed"),
          25_000,
        )
        expect(settled, `Root model requests: ${yield* app.modelRequestCount}`).not.toContain("Execution failed")
        expect(settled).toContain("Oracle has spoken")
        expect(settled).not.toContain("Running 1 subagent")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
