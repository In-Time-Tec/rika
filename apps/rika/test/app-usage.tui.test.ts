import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 90_000

test(
  "keeps accumulated usage visible after an attempt settles without usage",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              steps: [
                model.turn([model.part("PRICED_TURN_COMPLETE")], { inputTokens: 1_200, outputTokens: 340 }),
                model.failure("UNPRICED_TURN_FAILED"),
              ],
            },
          ],
        })

        yield* Effect.promise(() => app.type("Price this turn."))
        app.pressEnter()
        yield* app.waitFrame("PRICED_TURN_COMPLETE")
        // Live preview shows the answer text before the attempt commits usage; usage is only
        // available once the turn settles and the footer leaves the streaming state.
        yield* app.settled
        yield* app.waitFrame("ctx")
        yield* app.clickText("ctx")
        const priced = yield* app.waitFrame("Used")
        expect(priced).toContain("1.2K")
        expect(priced).not.toContain("$\u2014")
        app.pressEscape()
        yield* app.waitGone("Used       ")

        yield* Effect.promise(() => app.type("Fail this turn."))
        app.pressEnter()
        yield* app.waitFrame("Execution failed")
        yield* app.settled
        yield* app.clickText("ctx")
        const settledFrame = yield* app.waitFrame("Used")
        expect(settledFrame).toContain("1.2K")
        expect(settledFrame).not.toContain("$\u2014")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
