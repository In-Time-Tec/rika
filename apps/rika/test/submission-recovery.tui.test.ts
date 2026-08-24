import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./support/tui-app.harness"
import { model } from "./support/tui-model.fixture"

const tuiTestTimeout = 90_000

test(
  "restores a failed connected submission and lets Enter retry it",
  () =>
    TuiApp.run(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* TuiApp.tuiApp({
            submissionFailure: (attempt) => (attempt === 1 ? "host unavailable" : undefined),
            script: [model.text("RETRY_SUCCEEDED")],
          })
          yield* Effect.tryPromise(() => app.type("retry this prompt"))
          app.pressEnter()
          const rejected = yield* app.waitFrame("host unavailable")
          expect(rejected).toContain("retry this prompt")
          expect(yield* app.submissionAttempts).toBe(1)

          app.pressEnter()
          const retried = yield* app.waitFrame("RETRY_SUCCEEDED")
          expect(retried).toContain("retry this prompt")
          expect(yield* app.submissionAttempts).toBe(2)
          yield* app.quit
        }),
      ),
    ),
  tuiTestTimeout,
)

test(
  "restores the same composer when attachment materialization fails",
  () =>
    TuiApp.run(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* TuiApp.tuiApp({ script: [] })
          yield* Effect.tryPromise(() => app.type("inspect "))
          app.paste("/missing-rika-image.png")
          yield* app.waitFrame("[Image #1]")
          app.pressEnter()
          const rejected = yield* app.waitFrame("Image attachment could not be read")
          expect(rejected).toContain("inspect [Image #1]")
          expect(yield* app.submissionAttempts).toBe(0)
          yield* app.quit
        }),
      ),
    ),
  tuiTestTimeout,
)
