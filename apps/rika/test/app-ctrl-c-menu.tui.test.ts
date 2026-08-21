import { TextAttributes } from "@opentui/core"
import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000
const amber = "128,128,0,255"
const blue = "0,0,128,255"
const textColor = "192,192,192,255"

const spansFor = (app: TuiApp.TuiApp, text: string) =>
  app
    .spans()
    .lines.flatMap((line) => line.spans)
    .filter((span) => span.text.includes(text))

const createCurrentThread = (app: TuiApp.TuiApp) =>
  Effect.gen(function* () {
    yield* Effect.promise(() => app.type("Create the current thread."))
    app.pressEnter()
    yield* app.waitFrame("CURRENT_THREAD_READY")
    yield* app.waitTranscript(Turn.TurnId.make("tui-turn-0"), (projection) => projection.state.status === "completed")
    yield* app.settled
    return yield* app.waitThread("tui-thread-0", () => true)
  })

test(
  "matches the idle Amp Ctrl+C menu and cancels it with Escape",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({})

        app.pressKey("c", { ctrl: true })
        const menu = yield* app.waitFrame("Ctrl+N Archive and new thread")
        const lines = menu.split("\n")
        const archiveNewRow = lines.findIndex((line) => line.includes("Ctrl+N Archive and new thread"))
        expect(lines.slice(archiveNewRow, archiveNewRow + 4).map((line) => line.slice(-35, -2))).toEqual([
          "│ Ctrl+N Archive and new thread │",
          "│ Ctrl+E Archive and quit       │",
          "│ Ctrl+C Quit                   │",
          "│          Esc cancel           │",
        ])
        expect(lines[archiveNewRow - 1]).toContain("╭─ Ctrl+C then ─")
        expect(archiveNewRow).toBeGreaterThan(lines.length / 2)
        expect(lines[archiveNewRow]!.indexOf("Ctrl+N Archive and new thread")).toBe(67)
        expect(spansFor(app, "Ctrl+N")).toEqual([
          expect.objectContaining({
            attributes: expect.any(Number),
          }),
        ])
        expect(spansFor(app, "Ctrl+N")[0]!.fg.toInts().join(",")).toBe(blue)
        expect(spansFor(app, "Ctrl+N")[0]!.attributes & TextAttributes.BOLD).toBe(TextAttributes.BOLD)
        expect(
          spansFor(app, "Ctrl+C").some(
            (span) =>
              span.fg.toInts().join(",") === amber && (span.attributes & TextAttributes.BOLD) === TextAttributes.BOLD,
          ),
        ).toBe(true)
        expect(spansFor(app, "then")[0]!.fg.toInts().join(",")).toBe(textColor)
        expect(spansFor(app, "then")[0]!.attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)
        expect(spansFor(app, "cancel")[0]!.attributes & TextAttributes.DIM).toBe(TextAttributes.DIM)

        app.pressEscape()
        yield* app.waitGone("Ctrl+N Archive and new thread")

        yield* app.quit
        expect(yield* app.thread("tui-thread-0")).toBeUndefined()
      }),
    ),
  tuiTestTimeout,
)

test(
  "ignores unrelated menu keys and quits without archiving on a second Ctrl+C",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [model.text("CURRENT_THREAD_READY")],
          inspectTranscript: true,
        })

        yield* createCurrentThread(app)

        app.pressKey("c", { ctrl: true })
        yield* app.waitFrame("Ctrl+N Archive and new thread")
        app.pressKey("x")
        expect(yield* app.nextFrame).toContain("Ctrl+N Archive and new thread")
        app.pressKey("c", { ctrl: true })
        yield* app.done

        expect(yield* app.thread("tui-thread-0")).toMatchObject({ archived: false })
      }),
    ),
  tuiTestTimeout,
)

test(
  "keeps Ctrl+C cancellation behavior while a turn is busy",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [model.text("LATE_BUSY_RESPONSE", 20_000)],
          inspectTranscript: true,
        })

        yield* Effect.promise(() => app.type("Cancel this busy turn."))
        app.pressEnter()
        yield* app.waitModelRequests(1)
        yield* app.waitFrame("Waiting")
        app.pressKey("c", { ctrl: true })

        yield* app.waitTranscript(
          Turn.TurnId.make("tui-turn-0"),
          (projection) => projection.state.status === "cancelled",
        )
        expect(app.frame()).not.toContain("Ctrl+N Archive and new thread")

        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "dismisses an idle menu when asynchronous work starts and routes Ctrl+C to cancellation",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [model.text("LATE_ASYNC_RESPONSE", 20_000)],
          inspectTranscript: true,
        })

        app.pressKey("c", { ctrl: true })
        yield* app.waitFrame("Ctrl+N Archive and new thread")
        yield* Effect.forkChild(app.submit("Start work outside the keyboard handler."))
        yield* app.waitGone("Ctrl+N Archive and new thread")
        yield* app.waitFrame("Waiting")

        app.pressKey("c", { ctrl: true })
        yield* app.waitTranscript(
          Turn.TurnId.make("tui-turn-0"),
          (projection) => projection.state.status === "cancelled",
        )
        expect(app.frame()).not.toContain("Ctrl+N Archive and new thread")

        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "archives the current thread and activates a new empty thread with Ctrl+N",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [model.text("CURRENT_THREAD_READY")],
          inspectTranscript: true,
        })

        yield* createCurrentThread(app)
        expect(app.frame()).toContain("Create the current thread.")
        expect(app.frame()).toContain("CURRENT_THREAD_READY")

        app.pressKey("c", { ctrl: true })
        yield* app.waitFrame("Ctrl+N Archive and new thread")
        app.pressKey("n", { ctrl: true })

        expect(yield* app.waitThread("tui-thread-0", (thread) => thread.archived)).toMatchObject({ archived: true })
        expect(yield* app.waitThread("tui-thread-1", (thread) => !thread.archived)).toMatchObject({
          title: "New thread",
          archived: false,
        })
        yield* app.waitFrame("Welcome to Rika")
        yield* app.settled
        const replacement = yield* app.nextFrame
        expect(replacement).not.toContain("Create the current thread.")
        expect(replacement).not.toContain("CURRENT_THREAD_READY")

        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "archives the current thread before quitting with Ctrl+E",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [model.text("CURRENT_THREAD_READY")],
          inspectTranscript: true,
        })

        yield* createCurrentThread(app)

        app.pressKey("c", { ctrl: true })
        yield* app.waitFrame("Ctrl+E Archive and quit")
        app.pressKey("e", { ctrl: true })
        yield* app.done

        expect(yield* app.thread("tui-thread-0")).toMatchObject({ archived: true })
      }),
    ),
  tuiTestTimeout,
)
