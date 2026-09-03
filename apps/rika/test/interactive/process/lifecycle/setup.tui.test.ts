import { expect, test } from "vitest"
import { Deferred, Effect } from "effect"
import * as TuiApp from "../../../support/tui-app.harness"
import { model } from "../../../support/tui-model.fixture"

const tuiTestTimeout = 90_000

test(
  "restores a failed prompt to the composer without leaving a duplicate transcript echo",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({ script: [model.failure("FAILED_BEFORE_ANY_OUTPUT")] })

        yield* Effect.tryPromise(() => app.type("DUPLICATE_ECHO_PROMPT"))
        app.pressEnter()
        yield* app.waitFrame("Execution failed")
        const failed = yield* app.settled
        yield* app.quit
        return failed
      }),
    )["then"]((failed) => {
      expect(failed).toContain("UPLICATE_ECHO_PROMPT")
      expect(failed.match(/UPLICATE_ECHO_PROMPT/g) ?? []).toHaveLength(1)
    }),
  tuiTestTimeout,
)

test(
  "loads previous Threads during startup before the switcher opens",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const refreshed = yield* Deferred.make<void>()
        let refreshCount = 0
        const app = yield* TuiApp.tuiApp({
          historicalTranscriptFixture: {
            threadId: "thread-before-picker-opens",
            entryCount: 2,
            marker: "unused",
          },
          onRefreshThreads: () => {
            refreshCount += 1
            Deferred.doneUnsafe(refreshed, Effect.void)
          },
          mapInteractiveEvent: (event) =>
            event._tag === "ThreadsListed" && refreshCount === 0 ? { ...event, threads: [] } : event,
        })

        yield* Deferred.await(refreshed)
        expect(refreshCount).toBeGreaterThan(0)
        expect(yield* app.modelRequestCount).toBe(0)

        app.pressKey("t", { ctrl: true })
        const switcher = yield* app.waitFrameMatch(
          (frame) => frame.includes("Switch Thread") && frame.includes("Durable history"),
        )
        expect(switcher).toContain("Durable history")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
