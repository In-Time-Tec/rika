import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "../../support/tui-app.harness"
import { model } from "../../support/tui-model.fixture"

const tuiTestTimeout = 60_000

test(
  "keeps two spawns of one profile apart inside a single cell",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        // Two spawns of one profile from one cell share an admission key, so only the ordinal tells
        // them apart. Without it Generalist reads the second as a repeat of the first and one child runs.
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              steps: [
                model.turn([
                  model.spawn(
                    [
                      { profile: "Task", prompt: "FIRST_SAME" },
                      { profile: "Task", prompt: "SECOND_SAME" },
                    ],
                    "same-cell",
                  ),
                ]),
                model.text("ROOT_SAME_DONE"),
                // Either child can settle after the root answer and resume this same Run.
                model.text("FIRST_SAME_SETTLEMENT_ACKNOWLEDGED"),
                model.text("SECOND_SAME_SETTLEMENT_ACKNOWLEDGED"),
                model.text("FIRST_SAME_SETTLEMENT_RETRY_ACKNOWLEDGED"),
                model.text("SECOND_SAME_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            { profile: "Task", steps: [model.text("CHILD_A"), model.text("CHILD_B")] },
          ],
          height: 48,
        })
        yield* Effect.tryPromise(() => app.type("Delegate twice under one id."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_SAME_DONE", 30_000)
        const completed = yield* app.waitFrameMatch(
          (frame) => (frame.match(/Subagent finished/g) ?? []).length === 2,
          30_000,
        )
        expect(completed.match(/Subagent finished/g) ?? []).toHaveLength(2)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
