import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000

test(
  "keeps two spawns of one profile apart inside a single cell",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        // Two spawns of one profile from one cell share an admission key, so only the ordinal tells
        // them apart. Without it Baton reads the second as a repeat of the first and one child runs.
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
              ],
            },
            { profile: "Task", steps: [model.text("CHILD_A"), model.text("CHILD_B")] },
          ],
          height: 48,
        })
        yield* Effect.promise(() => app.type("Delegate twice under one id."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_SAME_DONE", 30_000)
        yield* app.settled
        expect((app.frame().match(/Subagent finished/g) ?? []).length).toBe(2)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
