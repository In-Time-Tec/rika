import { Deferred, Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 90_000

test(
  "submits during hosted startup without reopening the attached Thread",
  () =>
    TuiApp.run(
      Effect.scoped(
        Effect.gen(function* () {
          const admit = yield* Deferred.make<void>()
          const app = yield* TuiApp.tuiApp({
            historicalTranscriptFixture: {
              threadId: "tui-thread-0",
              entryCount: 3,
              marker: "SEEDED_THREAD",
            },
            initialThreadId: "tui-thread-0",
            initialThreadSelected: true,
            initialConnectionStatus: "connecting",
            idStart: 10,
            holdSubmissionAdmission: admit,
            width: 80,
            height: 24,
            script: [model.text("STARTUP_REPLY")],
          })
          yield* app.waitFrame("SEEDED_THREAD")
          yield* Effect.promise(() => app.type("Send while connecting"))
          app.pressEnter()
          yield* app.nextFrame
          const submitted = yield* app.nextFrame
          expect(submitted).toContain("Connecting")
          expect(submitted).toContain("Send while connecting")
          expect(submitted).not.toContain("Thread is still loading")
          expect(yield* app.modelRequestCount).toBe(0)
          yield* app.setConnectionStatus("connected")
          yield* Deferred.succeed(admit, undefined)
          const completed = yield* app.waitFrame("STARTUP_REPLY")
          expect(completed).not.toContain("Connecting")
          yield* app.quit
        }),
      ),
    ),
  tuiTestTimeout,
)
