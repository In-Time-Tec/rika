import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"

const tuiTestTimeout = 60_000

test(
  "confirms an idle Ctrl+C before quitting",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({})

        app.pressKey("c", { ctrl: true })
        const confirmation = yield* app.waitFrame("Ctrl+C Quit")
        expect(confirmation).toContain("Esc cancel")
        const lines = confirmation.split("\n")
        const quitRow = lines.findIndex((line) => line.includes("Ctrl+C Quit"))
        expect(quitRow).toBeGreaterThan(lines.length / 2)
        expect(lines[quitRow]!.indexOf("Ctrl+C Quit")).toBeGreaterThan(50)

        app.pressEscape()
        yield* app.waitGone("Ctrl+C Quit")

        app.pressKey("c", { ctrl: true })
        yield* app.waitFrame("Ctrl+C Quit")
        app.pressKey("c", { ctrl: true })
        yield* app.done
      }),
    ),
  tuiTestTimeout,
)
