import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000

test(
  "shows connecting and reconnecting in the bottom-left status without closing the TUI",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          initialConnectionStatus: "connecting",
          script: [model.text("WORK_CONTINUED", 1_000)],
        })

        expect(yield* app.waitFrame("Connecting")).toContain("Welcome to Rika")
        yield* app.setConnectionStatus("connected")
        yield* app.waitGone("Connecting")

        yield* Effect.promise(() => app.type("Keep working during replacement"))
        app.pressEnter()
        yield* app.waitFrame("Waiting")
        yield* app.setConnectionStatus("reconnecting")
        const reconnecting = yield* app.waitFrame("Reconnecting")
        expect(reconnecting).toContain("Keep working during replacement")

        yield* app.setConnectionStatus("connected")
        yield* app.waitGone("Reconnecting")
        yield* app.waitFrame("WORK_CONTINUED")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
