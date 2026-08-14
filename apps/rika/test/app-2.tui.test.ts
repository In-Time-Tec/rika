import { expect, test } from "vitest"
import { Effect, FileSystem } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const activeTimePattern = /◷ [0-9]+s/u
const tuiTestTimeout = 60_000

test(
  "shows elapsed active time for the first turn of a new session",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({ script: [model.text("TIMER_COMPLETE", 1_500)] })

        yield* Effect.promise(() => app.type("Measure this turn."))
        app.pressEnter()
        yield* app.waitFrame("ctx")
        yield* app.clickText("ctx")
        yield* app.waitFrame("Active")
        const active = yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))
        expect(active).toMatch(/◷ [0-9]+s/u)
        expect(active).not.toContain("◷ ····")
        yield* app.waitFrame("TIMER_COMPLETE")
        yield* app.settled
        expect(yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))).toMatch(activeTimePattern)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "restores elapsed active time after reopening the persisted thread",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({
          directory: "/tmp",
          prefix: "rika-timer-reopen-",
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* TuiApp.tuiApp({
              root,
              workspaceFiles: { "timer.txt": "TIMER" },
              script: [
                model.turn([
                  model.binding({ module: "workspace", operation: "read", input: { path: "timer.txt" } }, "timer-read"),
                ]),
                model.text("PERSISTED_TIMER_COMPLETE", 1_500),
              ],
            })
            yield* Effect.promise(() => app.type("Persist this timer."))
            app.pressEnter()
            yield* app.waitFrame("ctx")
            yield* app.clickText("ctx")
            yield* app.waitFrame("Active")
            yield* app.waitFrame("PERSISTED_TIMER_COMPLETE")
            yield* app.settled
            const settledFrame = yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))
            expect(settledFrame).toMatch(activeTimePattern)
            yield* app.quit
          }),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* TuiApp.tuiApp({ root, initialThreadId: "tui-thread-0", idStart: 10, script: [] })
            yield* app.waitFrame("ctx")
            yield* app.clickText("ctx")
            yield* app.waitFrame("Active")
            const restoredFrame = yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))
            const restored = restoredFrame.match(activeTimePattern)![0]
            expect(restored).not.toBe("◷ —")
            expect(restoredFrame).toContain(restored)
            yield* app.quit
          }),
        )
      }),
    ),
  tuiTestTimeout,
)
