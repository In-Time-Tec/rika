import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { testRender } from "@opentui/solid"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { createComponent } from "solid-js"
import { App } from "../../src/app"
import { createClient } from "../../src/client/runtime"
import { verifyProjection } from "./transcript-projection"

const lifecycle = Effect.scoped(
  Effect.gen(function* () {
    verifyProjection()
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => createClient({ scenario: "welcome" })),
      (value) => value.dispose,
    )
    let quits = 0
    const screen = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        testRender(
          () =>
            createComponent(App, {
              client,
              animate: false,
              onQuit: () => {
                quits += 1
              },
            }),
          {
            width: 216,
            height: 62,
            exitOnCtrlC: false,
          },
        ),
      ),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    yield* Effect.tryPromise(() => screen.flush())
    const welcome = screen
      .captureSpans()
      .lines.flatMap((line) => line.spans)
      .find((span) => span.text === "Welcome to Rika")
    assert.ok(welcome !== undefined && (welcome.attributes & 1) !== 0)
    screen.mockInput.pressKey("t", { meta: true })
    yield* Effect.tryPromise(() => screen.flush())
    const withSidebar = screen.captureCharFrame().split("\n")
    assert.equal(withSidebar.find((line) => line.includes("Welcome to Rika"))?.indexOf("Welcome to Rika"), 84)
    assert.match(withSidebar[0] ?? "", /Files \(\d+\)/)
    screen.mockInput.pressKey("?")
    yield* Effect.tryPromise(() => screen.flush())
    assert.match(screen.captureCharFrame().split("\n")[46] ?? "", /command palette/)
    screen.mockInput.pressEscape()
    yield* Effect.sleep(50)
    screen.mockInput.pressKey("y", { ctrl: true })
    yield* Effect.tryPromise(() => screen.flush())
    assert.match(screen.captureCharFrame(), /Context & Usage/)
    assert.match(screen.captureCharFrame(), /258\.4K/)
    screen.mockInput.pressEscape()
    yield* Effect.sleep(50)
    screen.mockInput.pressKey("t", { ctrl: true })
    yield* Effect.tryPromise(() => screen.flush())
    assert.match(screen.captureCharFrame(), /Switch Thread/)
    screen.captureSpans()
    screen.mockInput.pressEscape()
    yield* Effect.sleep(50)
    screen.mockInput.pressCtrlC()
    yield* Effect.tryPromise(() => screen.flush())
    const exit = screen.captureCharFrame()
    assert.doesNotMatch(exit, /Switch Thread/)
    assert.match(exit, /Ctrl\+C then/)
    assert.match(exit, /Archive and new thread/)
    assert.equal(quits, 0)
    assert.ok(screen.captureSpans().lines.some((line) => line.spans.some((span) => span.text.includes("Ctrl+C"))))
    screen.mockInput.pressCtrlC()
    assert.equal(quits, 1)
  }),
)

BunRuntime.runMain(lifecycle)
