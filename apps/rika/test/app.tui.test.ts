import { expect, test } from "vitest"
import { Effect, FileSystem, Path } from "effect"
import * as TuiApp from "./tui-app"

const settled = (app: TuiApp.TuiApp) =>
  Effect.gen(function* () {
    yield* app.waitGone("Waiting")
    yield* app.waitGone("Streaming")
    yield* app.waitGone("Running tools")
    yield* app.waitGone("Thinking")
  })

test(
  "runs turns, tools, pickers, and surfaces in one real TUI session",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "src/alpha.ts": "alpha", "src/beta.ts": "beta", "README.md": "readme" },
          script: [
            TuiApp.model.text("HARNESS_RESPONSE"),
            TuiApp.model.turn([TuiApp.model.toolCall("bash", { command: "printf TOOL_OK" }, "ordinary-tool")]),
            TuiApp.model.text("ORDINARY_COMPLETE"),
            TuiApp.model.text("MENTION_COMPLETE"),
            TuiApp.model.text("MENTION_COMPLETE"),
          ],
        })
        yield* Effect.promise(() => app.type("Say hello."))
        app.pressEnter()
        const first = yield* app.waitFrame("HARNESS_RESPONSE")
        expect(first).toContain("Say hello.")
        yield* settled(app)

        yield* Effect.promise(() => app.type("Run an ordinary tool."))
        app.pressEnter()
        const ordinary = yield* app.waitFrame("ORDINARY_COMPLETE")
        expect(ordinary).toContain("printf TOOL_OK")
        expect(ordinary).not.toContain("Allow once")
        expect(ordinary).not.toContain("[pending]")
        yield* settled(app)

        yield* Effect.promise(() => app.type("check @"))
        const opened = yield* app.waitFrame("@README.md")
        expect(opened).toContain("@src")
        yield* Effect.promise(() => app.type("alpha"))
        const narrowed = yield* app.waitFrame("@src/alpha.ts")
        expect(narrowed).not.toContain("@README.md")
        app.pressEnter()
        yield* app.waitFrame("check @src/alpha.ts")
        app.pressEnter()
        yield* app.waitFrame("MENTION_COMPLETE")
        yield* settled(app)

        app.pressKey("t", { alt: true })
        const tree = yield* app.waitFrame("Files (3)")
        expect(tree).toContain("src/")
        expect(tree).toContain("alpha.ts")
        expect(tree).toContain("README.md")
        app.pressKey("t", { alt: true })
        yield* app.waitGone("Files (")

        app.pressKey("s", { ctrl: true })
        yield* app.waitFrame("Balanced intelligence, speed, and cost for most tasks")
        app.pressArrow("right")
        yield* app.waitFrame("Deep reasoning for hard tasks")
        app.pressEscape()
        const escaped = yield* app.waitGone("Deep reasoning")
        expect(escaped).toContain("medium")
        app.pressKey("s", { ctrl: true })
        yield* app.waitFrame("Balanced intelligence, speed, and cost for most tasks")
        app.pressArrow("right")
        yield* app.waitFrame("Deep reasoning for hard tasks")
        app.pressEnter()
        const applied = yield* app.waitGone("Deep reasoning")
        expect(applied).toContain("high")

        app.pressKey("o", { ctrl: true })
        const palette = yield* app.waitFrame("Command Palette")
        expect(palette).toContain("switch")
        expect(palette).toContain("toggle fast mode")
        expect(palette).toContain("quit")
        app.pressEscape()
        yield* app.waitGone("Command Palette")

        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "resolves shell permissions across allow, deny, and always in one session",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const app = yield* TuiApp.tuiApp({ script: [], shellPermission: "ask" })

        yield* Effect.promise(() => app.type("$printf '\\101\\114\\114\\117\\127\\105\\104'"))
        app.pressEnter()
        const pending = yield* app.waitFrame("Run shell command")
        expect(pending).toContain("[pending]")
        expect(pending).toContain("› Allow once")
        expect(pending).toContain("Deny")
        app.pressEnter()
        const allowed = yield* app.waitFrame("ALLOWED")
        expect(allowed).toContain("? Run shell command [approved]")
        expect(allowed).not.toContain("[pending]")

        yield* Effect.promise(() => app.type("$printf SHOULD_NOT_RUN > denied.txt"))
        app.pressEnter()
        yield* app.waitFrame("› Allow once")
        app.pressArrow("left")
        yield* app.waitFrame("› Deny")
        app.pressEnter()
        const denied = yield* app.waitFrame("Shell command denied")
        expect(denied).toContain("? Run shell command [denied]")
        expect(yield* fileSystem.exists(path.join(app.workspace, "denied.txt"))).toBe(false)

        yield* Effect.promise(() =>
          app.type("$printf '\\101\\114\\127\\101\\131\\123\\137\\123\\105\\114\\105\\103\\124\\105\\104'"),
        )
        app.pressEnter()
        yield* app.waitFrame("› Allow once")
        app.pressArrow("right")
        const onAlways = yield* app.waitFrame("› Always")
        expect(onAlways).not.toContain("› Allow once")
        app.pressEnter()
        yield* app.waitFrame("ALWAYS_SELECTED")

        yield* Effect.promise(() => app.type("$printf '\\123\\105\\103\\117\\116\\104\\137\\117\\113'"))
        app.pressEnter()
        const second = yield* app.waitFrame("SECOND_OK")
        expect(second).not.toContain("[pending]")

        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "gates durable tool approvals on Enter and cancels pending approvals without running the tool",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "notes.txt": "APPROVAL_NOTES" },
          toolNeedsApproval: (name) => name === "read" || name === "bash",
          script: [
            TuiApp.model.turn([TuiApp.model.toolCall("read", { path: "notes.txt" }, "approved-read")]),
            TuiApp.model.text("APPROVAL_COMPLETE"),
            TuiApp.model.turn([
              TuiApp.model.toolCall("bash", { command: "printf CANCEL_PROOF > cancel-proof.txt" }, "cancelled-tool"),
            ]),
            TuiApp.model.text("APPROVAL_COMPLETE"),
          ],
        })

        yield* Effect.promise(() => app.type("Read the notes file."))
        app.pressEnter()
        const pending = yield* app.waitFrame("? read [pending]")
        expect(pending).toContain("› Allow once")
        app.pressEnter()
        const approved = yield* app.waitFrame("APPROVAL_COMPLETE")
        expect(approved).toContain("? read [approved]")
        expect(approved).not.toContain("[pending]")
        yield* settled(app)

        yield* Effect.promise(() => app.type("Cancel the approval."))
        app.pressEnter()
        yield* app.waitFrame("? bash [pending]")
        app.close()
        yield* app.waitFrame("⊘")
        expect(yield* fileSystem.exists(path.join(app.workspace, "cancel-proof.txt"))).toBe(false)

        app.close()
        yield* app.done
      }),
    ),
  240_000,
)

test(
  "cancels the active turn and promotes the queued turn",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [
            TuiApp.model.text("LATE_QUEUE_HEAD", 5_000),
            TuiApp.model.text("QUEUED_DONE"),
            TuiApp.model.text("QUEUED_DONE"),
          ],
        })
        yield* Effect.promise(() => app.type("Hold the queue head."))
        app.pressEnter()
        yield* app.waitFrame("Hold the queue head.")
        yield* Effect.promise(() => app.type("Queued follow-up prompt."))
        app.pressEnter()
        yield* app.waitFrame("Queued follow-up prompt.")
        app.pressKey("c", { ctrl: true })
        yield* app.waitFrame("\u2298")
        const promoted = yield* app.waitFrame("QUEUED_DONE")
        expect(promoted).not.toContain("LATE_QUEUE_HEAD")
        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "steers composer text into the active execution without queueing a turn",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "fixture.txt": "steer fixture body" },
          script: [
            TuiApp.model.turn([TuiApp.model.toolCall("read", { path: "fixture.txt" }, "steer-read")], {
              delay: "3000 millis",
            }),
            TuiApp.model.text("ACTIVE_STEER_COMPLETE"),
            TuiApp.model.text("ACTIVE_STEER_COMPLETE"),
          ],
        })
        yield* Effect.promise(() => app.type("Read the fixture slowly."))
        app.pressEnter()
        yield* app.waitFrame("Read the fixture slowly.")
        yield* Effect.promise(() => app.type("Focus on the exact fixture text."))
        yield* app.waitFrame("Focus on the exact fixture text.")
        app.pressKey("s", { ctrl: true })
        yield* app.waitGone("Focus on the exact fixture text.")
        const steered = yield* app.waitFrame("ACTIVE_STEER_COMPLETE")
        expect(steered).not.toContain("Execution failed")
        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "interrupts the active turn with Ctrl+Enter and runs the replacement",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [
            TuiApp.model.text("LATE_INTERRUPTED_RESPONSE", 5_000),
            TuiApp.model.text("REPLACEMENT_COMPLETE"),
            TuiApp.model.text("REPLACEMENT_COMPLETE"),
          ],
        })
        yield* Effect.promise(() => app.type("Begin interruptible work."))
        app.pressEnter()
        yield* app.waitFrame("Begin interruptible work.")
        yield* Effect.promise(() => app.type("Run the replacement prompt."))
        yield* app.waitFrame("Run the replacement prompt.")
        app.pressKey("\u001b[13;5u")
        const replaced = yield* app.waitFrame("REPLACEMENT_COMPLETE")
        expect(replaced).toContain("Run the replacement prompt.")
        expect(replaced).not.toContain("LATE_INTERRUPTED_RESPONSE")
        yield* app.quit
      }),
    ),
  240_000,
)
