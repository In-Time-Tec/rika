import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "../../../support/tui-app.harness"
import { model } from "../../../support/tui-model.fixture"

const tuiTestTimeout = 60_000
test(
  "shows a running bash tool as running work on the activity line",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        // The activity line is the only thing telling a reader a tool is still working. Every gate
        // we run reads a model or a projection, so a client that computes the line correctly and
        // never renders it stays green everywhere; this reads the frame a user sees.
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "slow.txt": "SLOW_BODY" },
          script: [
            model.turn([model.tool("bash", { command: "sleep 2", timeout_ms: 8_000 }, "slow-bash")]),
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
