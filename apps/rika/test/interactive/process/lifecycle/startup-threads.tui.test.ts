import { expect, test } from "vitest"
import { Deferred, Effect } from "effect"
import * as TuiApp from "../../../support/tui-app.harness"

const tuiTestTimeout = 90_000

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
