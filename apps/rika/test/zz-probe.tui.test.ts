import { test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"

test(
  "probe",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          root: "/private/tmp/claude-501/-Users-dallenpyrah-Projects-rika/b521e6ba-88a2-4029-bdb6-07c8540da96f/scratchpad/probe",
          script: [
            TuiApp.model.toolCall("task", { prompt: "SILENT_AGENT_PROMPT" }, "silent-agent"),
            TuiApp.model.turn([]),
            TuiApp.model.text("ROOT_AFTER_NO_REPORT"),
          ],
          width: 100,
          height: 44,
        })
        yield* Effect.promise(() => app.type("Delegate and get nothing back."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_AFTER_NO_REPORT")
        yield* app.waitGone("Waiting")
        yield* app.waitGone("Streaming")
        yield* app.waitGone("Running 1 tool")
        yield* app.waitGone("Thinking")
        app.pressKey("\t")
        app.pressEnter()
        yield* Effect.sleep("500 millis")
        console.log("=== EXPANDED ===\n" + app.frame())
        yield* app.quit
      }),
    ),
  240_000,
)
