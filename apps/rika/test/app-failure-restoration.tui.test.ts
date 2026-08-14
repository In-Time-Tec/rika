import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000

test(
  "restores a failed prompt to the composer without leaving a duplicate transcript echo",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({ script: [model.failure("FAILED_BEFORE_ANY_OUTPUT")] })

        yield* Effect.promise(() => app.type("DUPLICATE_ECHO_PROMPT"))
        app.pressEnter()
        yield* app.waitFrame("Execution failed")
        const failed = yield* app.settled
        yield* app.quit
        return failed
      }),
    ).then((failed) => {
      expect(failed).toContain("UPLICATE_ECHO_PROMPT")
      expect(failed.match(/UPLICATE_ECHO_PROMPT/g) ?? []).toHaveLength(1)
    }),
  tuiTestTimeout,
)
