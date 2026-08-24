import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000
test(
  "stays responsive to input while a subagent turn is still streaming",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Task", prompt: "RESPONSIVE_CHILD_PROMPT" }], "responsive-child")]),
                model.text("RESPONSIVE_ROOT_COMPLETE"),
                model.text("RESPONSIVE_CHILD_SETTLEMENT_ACKNOWLEDGED"),
                model.text("RESPONSIVE_CHILD_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            // Typing while the child streams measures well under a second, so the child answer is
            // held with several times that margin rather than for five seconds.
            { profile: "Task", steps: [model.text("RESPONSIVE_CHILD_RESULT", 2_000)] },
          ],
        })

        yield* Effect.tryPromise(() => app.type("Delegate slow work."))
        app.pressEnter()
        yield* app.waitFrame("Subagent working")

        yield* Effect.tryPromise(() => app.type("TYPED_WHILE_STREAMING"))
        const responsive = yield* app.waitFrame("TYPED_WHILE_STREAMING")
        expect(responsive).toContain("Subagent working")
        expect(responsive).toContain("Running 1 subagent")

        const completed = yield* app.waitFrame("RESPONSIVE_ROOT_COMPLETE")
        expect(completed).toContain("TYPED_WHILE_STREAMING")
        expect(completed).not.toContain("Execution failed")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
