import { expect, test } from "vitest"
import { Deferred, Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 90_000
const green = "0,128,0,255"
const hasGreenText = (app: TuiApp.TuiApp, text: string): boolean =>
  app
    .spans()
    .lines.flatMap((line) => line.spans)
    .some((span) => span.text.includes(text) && span.fg.toInts().join(",") === green)

test(
  "echoes an idle submission in the next frame before server admission",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const admission = yield* Deferred.make<void>()
        const app = yield* TuiApp.tuiApp({
          holdSubmissionAdmission: admission,
          script: [model.text("OPTIMISTIC_ECHO_COMPLETE")],
        })

        yield* Effect.promise(() => app.type("OPTIMISTIC_ECHO_PROMPT"))
        app.pressEnter()
        const submittedFrame = yield* app.nextFrame
        expect(submittedFrame).toContain("OPTIMISTIC_ECHO_PROMPT")
        expect(submittedFrame.match(/OPTIMISTIC_ECHO_PROMPT/g) ?? []).toHaveLength(1)
        expect(submittedFrame).toContain("Sending")

        yield* Deferred.succeed(admission, undefined)
        const completed = yield* app.waitFrame("OPTIMISTIC_ECHO_COMPLETE")
        expect(completed.match(/OPTIMISTIC_ECHO_PROMPT/g) ?? []).toHaveLength(1)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "restores a submitted prompt when cancellation wins before model output",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [model.text("CANCELLED_LATE_RESPONSE", 20_000), model.text("RESTORED_PROMPT_SENT")],
        })

        yield* Effect.promise(() => app.type("Restore this submitted prompt."))
        app.pressEnter()
        yield* app.waitFrame("Restore this submitted prompt.")
        yield* app.waitModelRequests(1)
        app.close()
        const restored = yield* app.waitFrame("│ Restore this submitted prompt.")
        expect(restored).not.toContain("⊘")
        expect(restored).not.toContain("cancelled")
        yield* Effect.promise(() => app.type(" again"))
        app.pressEnter()
        yield* app.waitFrame("RESTORED_PROMPT_SENT")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "echoes a queued prompt beside the streaming turn and drains it without a restart",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          // Keep the first provider response pending long enough that a constrained CI runner
          // cannot cross the active-to-idle boundary while the second prompt is being entered.
          script: [model.text("SLOW_FIRST_ANSWER", 20_000), model.text("QUEUED_SECOND_ANSWER")],
        })
        yield* Effect.promise(() => app.type("First slow prompt."))
        app.pressEnter()
        yield* app.waitFrame("First slow prompt.")
        yield* app.waitModelRequests(1)
        yield* Effect.promise(() => app.type("Second queued prompt."))
        app.pressKey("\u001b[13;3u")
        const queuedFrame = yield* app.waitFrame("Second queued prompt.")
        expect(queuedFrame).toContain("First slow prompt.")
        expect(hasGreenText(app, "Second queued prompt.")).toBe(false)
        const finalFrame = yield* app.waitFrame("QUEUED_SECOND_ANSWER", 30_000)
        expect(finalFrame).toContain("SLOW_FIRST_ANSWER")
        expect(hasGreenText(app, "Second queued prompt.")).toBe(true)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "cancels the active turn and promotes the queued turn",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [model.text("LATE_QUEUE_HEAD", 20_000), model.text("QUEUED_DONE")],
        })
        yield* Effect.promise(() => app.type("Hold the queue head."))
        app.pressEnter()
        yield* app.waitFrame("Hold the queue head.")
        yield* Effect.promise(() => app.type("Queued follow-up prompt."))
        app.pressKey("\u001b[13;3u")
        yield* app.waitFrame("Queued follow-up prompt.")
        yield* app.waitModelRequests(1)
        app.pressKey("c", { ctrl: true })
        const promoted = yield* app.waitFrame("QUEUED_DONE")
        yield* app.settled
        expect(promoted).not.toContain("LATE_QUEUE_HEAD")
        expect(promoted).not.toContain("\u2298")
        expect(promoted).not.toContain("Execution failed")
        expect(promoted).not.toContain("wait cancelled")
        expect(promoted).not.toContain("! cancelled")
        expect(promoted).not.toContain("Cancellation requested")
        expect(promoted).not.toContain("Cancelled by user")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "steers entered prompts on the same queued row and delivers them into the turn",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "fixture.txt": "steer fixture body" },
          script: [
            model.turn(
              [model.binding({ module: "workspace", operation: "read", input: { path: "fixture.txt" } }, "steer-read")],
              { delayMillis: 12_000 },
            ),
            model.text("ACTIVE_STEER_COMPLETE"),
          ],
        })
        yield* Effect.promise(() => app.type("Read the fixture slowly."))
        app.pressEnter()
        yield* app.waitFrame("Read the fixture slowly.")
        yield* app.waitFrame("Waiting")
        yield* Effect.promise(() => app.type("Focus on the exact fixture text."))
        app.pressEnter()
        yield* app.waitFrame("steering: Focus")
        yield* Effect.promise(() => app.type("Answer in one sentence."))
        app.pressEnter()
        yield* app.waitFrame("steering: Answer")
        yield* app.waitFrame("ACTIVE_STEER_COMPLETE", 25_000)
        yield* app.settled
        const consumed = yield* app.waitGone("steering: Focus")
        expect(consumed).not.toContain("Execution failed")
        expect(consumed).not.toContain("steering: Answer")
        expect(consumed.match(/Answer in one sentence\./g) ?? []).toHaveLength(1)
        expect(consumed.match(/Focus on the exact fixture text\./g) ?? []).toHaveLength(1)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "interrupts the active turn with Ctrl+Enter and runs the replacement",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [model.text("LATE_INTERRUPTED_RESPONSE", 20_000), model.text("REPLACEMENT_COMPLETE")],
        })
        yield* Effect.promise(() => app.type("Begin interruptible work."))
        app.pressEnter()
        yield* app.waitFrame("Begin interruptible work.")
        yield* app.waitModelRequests(1)
        yield* Effect.promise(() => app.type("Run the replacement prompt."))
        yield* app.waitFrame("Run the replacement prompt.")
        app.pressKey("\u001b[13;5u")
        const replaced = yield* app.waitFrame("REPLACEMENT_COMPLETE")
        expect(replaced).toContain("Run the replacement prompt.")
        expect(replaced).not.toContain("LATE_INTERRUPTED_RESPONSE")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
