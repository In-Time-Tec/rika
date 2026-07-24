import { expect, test } from "vitest"
import { Theme } from "@rika/tui"
import { Effect, FileSystem, Path } from "effect"
import * as TuiApp from "./tui-app"

const settled = (app: TuiApp.TuiApp) =>
  Effect.gen(function* () {
    yield* app.waitGone("Waiting")
    yield* app.waitGone("Streaming")
    yield* app.waitGone("Running 1 tool")
    yield* app.waitGone("Thinking")
  })

const spanHasColor = (app: TuiApp.TuiApp, text: string, color: typeof Theme.colors.text): boolean =>
  app
    .spans()
    .lines.flatMap((line) => line.spans)
    .some((span) => span.text.includes(text) && span.fg.toInts().join(",") === color.toInts().join(","))

test(
  "reloads a failed root with completed nested subagents from durable state",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [
            TuiApp.model.toolCall("task", { prompt: "Run top-level work." }, "top-agent"),
            TuiApp.model.toolCall("task", { prompt: "Run nested work." }, "nested-agent"),
            TuiApp.model.text("NESTED_RELOAD_COMPLETE"),
            TuiApp.model.text("TOP_LEVEL_RELOAD_COMPLETE"),
            TuiApp.model.failure("ROOT_RELOAD_FAILED"),
          ],
        })

        yield* Effect.promise(() => app.type("Delegate nested work, then fail."))
        app.pressEnter()
        const failed = yield* app.waitFrame("ROOT_RELOAD_FAILED")
        expect(failed).toContain("Execution failed")
        expect(failed).not.toContain("Running 1 subagent")

        yield* app.reload
        const reloaded = yield* app.waitFrame("ROOT_RELOAD_FAILED")
        expect(reloaded).toContain("Execution failed")
        expect(reloaded).not.toContain("Running 1 subagent")
        app.pressKey("\t")
        app.pressEnter()
        yield* app.waitFrame("TOP_LEVEL_RELOAD_COMPLETE")
        app.pressKey("\t")
        app.pressEnter()
        const nested = yield* app.waitFrame("NESTED_RELOAD_COMPLETE")
        expect(nested).toContain("Subagent finished")
        expect(nested).not.toContain("Subagent working")
        expect(nested).not.toContain("Subagent failed")
        expect(nested).not.toContain("Running 1 subagent")
        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "preserves primary and muted nested tool summary spans through the real app stack",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "nested.txt": "NESTED_TOOL_CONTENT" },
          script: [
            TuiApp.model.toolCall("oracle", { prompt: "Read the nested fixture." }, "oracle-style"),
            TuiApp.model.toolCall("read", { path: "nested.txt" }, "nested-read"),
            TuiApp.model.text("## Oracle result\n\n**ORACLE_STYLE_RESULT**"),
            TuiApp.model.text("ROOT_STYLE_RESULT"),
          ],
        })

        yield* Effect.promise(() => app.type("Ask Oracle to inspect the fixture."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_STYLE_RESULT")
        expect(spanHasColor(app, "Oracle", Theme.colors.text), "Oracle primary span").toBe(true)
        expect(spanHasColor(app, " has spoken", Theme.colors.muted), "Oracle lifecycle span").toBe(true)
        app.pressKey("\t")
        yield* app.waitFrame("Oracle has spoken")
        app.pressEnter()
        yield* app.waitFrame("Read nested.txt")
        yield* settled(app)
        const completed = app.frame()
        expect(completed.match(/Oracle has spoken/g) ?? []).toHaveLength(1)
        expect(completed.match(/Read nested\.txt/g) ?? []).toHaveLength(1)
        expect(completed).toContain("Oracle result")
        expect(completed).toContain("ORACLE_STYLE_RESULT")
        expect(completed).not.toContain("## Oracle result")
        expect(completed).not.toContain("The subagent finished without a final message.")
        expect(spanHasColor(app, "Read", Theme.colors.text), "Read primary span").toBe(true)
        expect(spanHasColor(app, " nested.txt", Theme.colors.muted), "Read path span").toBe(true)
        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "settles repeated process waits while the original shell row owns process liveness",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const command = "printf EARLY_OUTPUT; sleep 1; printf FINAL_OUTPUT"
        const app = yield* TuiApp.tuiApp({
          script: [
            TuiApp.model.turn([TuiApp.model.toolCall("bash", { command, timeout_ms: 0 }, "bash-wait")]),
            TuiApp.model.turn([
              TuiApp.model.toolCall("shell_command_status", { processId: "1", waitMillis: 0 }, "wait-immediate"),
            ]),
            TuiApp.model.turn([
              TuiApp.model.toolCall("shell_command_status", { processId: "1", waitMillis: 10_000 }, "wait-final"),
            ]),
            TuiApp.model.text("SHELL_WAIT_COMPLETE"),
          ],
        })

        yield* Effect.promise(() => app.type("Run the process and wait for it."))
        app.pressEnter()
        yield* app.waitFrame("SHELL_WAIT_COMPLETE")
        yield* settled(app)
        app.pressKey("\t")
        app.pressEnter()
        const completed = yield* app.waitFrame("FINAL_OUTPUT")
        expect(completed.match(/Waited for/g) ?? []).toHaveLength(2)
        expect(completed).not.toContain("Waiting for")
        expect(completed).not.toContain("Running 1 tool")
        expect(completed.match(/\$ printf EARLY_OUTPUT/g) ?? []).toHaveLength(1)
        yield* app.quit
      }),
    ),
  240_000,
)

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
  "restores a submitted prompt when cancellation wins before model output",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [
            TuiApp.model.text("CANCELLED_LATE_RESPONSE", 5_000),
            TuiApp.model.text("RESTORED_PROMPT_SENT"),
            TuiApp.model.text("RESTORED_PROMPT_SENT"),
          ],
        })

        yield* Effect.promise(() => app.type("Restore this submitted prompt."))
        app.pressEnter()
        yield* app.waitFrame("Restore this submitted prompt.")
        yield* app.waitFrame("Waiting")
        app.close()
        const restored = yield* app.waitFrame("Restore this submitted prompt.")
        expect(restored).not.toContain("⊘")
        expect(restored).not.toContain("cancelled")
        yield* Effect.promise(() => app.type(" again"))
        app.pressEnter()
        yield* app.waitFrame("RESTORED_PROMPT_SENT")
        yield* app.quit
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
        const promoted = yield* app.waitFrame("QUEUED_DONE")
        expect(promoted).not.toContain("LATE_QUEUE_HEAD")
        expect(promoted).not.toContain("\u2298")
        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "steers selected queued messages with a pending lane and distinct delivered entries",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "fixture.txt": "steer fixture body" },
          script: [
            TuiApp.model.turn([TuiApp.model.toolCall("read", { path: "fixture.txt" }, "steer-read")], {
              delay: "10000 millis",
            }),
            TuiApp.model.text("ACTIVE_STEER_COMPLETE"),
            TuiApp.model.text("ACTIVE_STEER_COMPLETE"),
            TuiApp.model.text("ACTIVE_STEER_COMPLETE"),
          ],
        })
        yield* Effect.promise(() => app.type("Read the fixture slowly."))
        app.pressEnter()
        yield* app.waitFrame("Read the fixture slowly.")
        yield* app.waitFrame("Waiting")
        const workingTitle = yield* app.waitTerminalTitle((title) => /^[⠀-⣿] /u.test(title))
        yield* app.waitTerminalTitle((title) => /^[⠀-⣿] /u.test(title) && title !== workingTitle)
        yield* Effect.promise(() => app.type("Focus on the exact fixture text."))
        app.pressEnter()
        yield* Effect.promise(() => app.type("Answer in one sentence."))
        yield* app.waitFrame("Focus on the exact fixture text.")
        app.pressKey("s", { ctrl: true })
        yield* app.waitFrame("steering: Answer in one sentence.")
        app.pressArrow("up")
        yield* app.waitFrame("Enter to steer")
        app.pressEnter()
        yield* app.waitFrame("steering: Focus on the exact fixture text.")
        const steered = yield* app.waitFrame("ACTIVE_STEER_COMPLETE")
        yield* settled(app)
        yield* app.waitTerminalTitle((title) => !/^[⠀-⣿] /u.test(title))
        expect(steered).not.toContain("Execution failed")
        expect(steered).not.toContain("steering:")
        expect(steered).toContain("\u2503 Answer in one sentence.")
        expect(steered).toContain("\u2503 Focus on the exact fixture text.")
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
