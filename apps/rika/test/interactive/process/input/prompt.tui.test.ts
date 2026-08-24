import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "../../../support/tui-app.harness"
import { model } from "../../../support/tui-model.fixture"

const tuiTestTimeout = 60_000

test(
  "returns the activity line to idle once every child has finished",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Oracle", prompt: "IDLE_CHILD_PROMPT" }], "idle-agent")]),
                model.text("IDLE_ROOT_DONE"),
                model.text("IDLE_SETTLEMENT_ACKNOWLEDGED"),
                model.text("IDLE_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            { profile: "Oracle", steps: [model.text("IDLE_CHILD_DONE")] },
          ],
          height: 40,
        })

        yield* Effect.tryPromise(() => app.type("Delegate once."))
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
