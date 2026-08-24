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

        yield* Effect.tryPromise(() => app.type("Run something slow."))
        app.pressEnter()
        const running = yield* app.waitFrame("Running", 20_000)
        expect(running).toContain("Running 1 tool")
        yield* app.waitFrame("ACTIVITY_LANE_COMPLETE", 25_000)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
