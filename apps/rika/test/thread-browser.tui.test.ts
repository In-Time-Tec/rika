import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"

const tuiTestTimeout = 60_000

test(
  "scrolls the thread preview without moving the main transcript",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          historicalTranscriptFixture: {
            threadId: "thread-browser-history",
            entryCount: 440,
            marker: "PREVIEW_OLDER_MARKER",
          },
          width: 110,
          height: 30,
        })

        const mainTail = yield* app.waitFrame("Historical transcript complete")
        expect(mainTail).not.toContain("PREVIEW_OLDER_MARKER")

        app.pressKey("t", { ctrl: true })
        const previewTail = yield* app.waitFrameMatch(
          (frame) => frame.includes("Thread Preview") && frame.includes("Historical transcript complete"),
        )
        expect(previewTail).not.toContain("PREVIEW_OLDER_MARKER")

        app.pressKey("\u001b[H")
        const previewOlder = yield* app.waitFrame("Historical transcript fixture")
        expect(previewOlder).toContain("Thread Preview")

        app.pressEscape()
        const restoredMainTail = yield* app.waitGone("Thread Preview")
        expect(restoredMainTail).toContain("Historical transcript complete")
        expect(restoredMainTail).not.toContain("PREVIEW_OLDER_MARKER")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
