import { expect, test } from "vitest"
import { Effect, FileSystem, Path } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 30_000

test(
  "runs durable read and shell tools immediately without approval prompts",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "notes.txt": "APPROVAL_NOTES" },
          script: [
            model.turn([
              model.binding({ module: "workspace", operation: "read", input: { path: "notes.txt" } }, "approved-read"),
            ]),
            model.text("APPROVAL_COMPLETE"),
            model.turn([
              model.binding(
                {
                  module: "processes",
                  operation: "start",
                  input: { command: "printf CANCEL_PROOF > cancel-proof.txt" },
                },
                "cancelled-tool",
              ),
            ]),
            model.text("BASH_COMPLETE"),
          ],
        })

        yield* Effect.promise(() => app.type("Read the notes file."))
        app.pressEnter()
        const completed = yield* app.waitFrame("APPROVAL_COMPLETE")
        expect(completed).not.toContain("[pending]")
        expect(completed).not.toContain("Allow once")
        yield* app.waitFrame("ctx")
        yield* app.clickText("ctx")
        yield* app.waitFrame("Active")
        expect(yield* app.waitFrame("◷ ")).toMatch(/◷ [0-9]+s/u)
        yield* app.settled
        expect(app.frame()).toMatch(/◷ [0-9]+s/u)

        yield* app.clickComposer
        yield* Effect.promise(() => app.type("Run the shell tool."))
        expect(app.frame()).not.toContain("Context & Usage")
        app.pressEnter()
        const shellCompleted = yield* app.waitFrame("BASH_COMPLETE")
        expect(shellCompleted).not.toContain("[pending]")
        expect(shellCompleted).not.toContain("Allow once")
        expect(yield* fileSystem.exists(path.join(app.workspace, "cancel-proof.txt"))).toBe(true)

        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

// Rika provides no Approvals service, so Baton approves every declared capability without asking
// and no authorization can reach the transcript. See docs/tradeoffs/declared-capabilities-that-do-not-act.md;
// this describes the behaviour that lane would have and runs when it is connected.
test.fails(
  "approves a pending write authorization from the transcript and denies the next one",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          height: 44,
          script: [
            model.turn([
              model.binding(
                { module: "workspace", operation: "write", input: { path: "approved.txt", content: "APPROVED_BODY" } },
                "write-approved",
              ),
            ]),
            model.text("APPROVED_WRITE_COMPLETE"),
            model.turn([
              model.binding(
                { module: "workspace", operation: "write", input: { path: "denied.txt", content: "DENIED_BODY" } },
                "write-denied",
              ),
            ]),
            model.text("DENIED_WRITE_COMPLETE"),
          ],
        })

        yield* Effect.promise(() => app.type("Write the approved file."))
        app.pressEnter()
        const pending = yield* app.waitFrame("Authorization pending", 3_000)
        expect(pending).toContain("write")
        expect(pending, "controls stay hidden until the card is selected").not.toContain("[a] Approve")

        app.pressKey("\t")
        app.pressKey("\t")
        const selected = yield* app.waitFrame("[a] Approve")
        expect(selected).toContain("[d] Deny")

        app.pressKey("a")
        yield* app.waitFrame("APPROVED_WRITE_COMPLETE", 20_000)
        yield* app.settled
        expect(yield* fileSystem.exists(path.join(app.workspace, "approved.txt"))).toBe(true)
        expect(app.frame()).toContain("Authorization approved")

        yield* app.clickComposer
        yield* Effect.promise(() => app.type("Write the denied file."))
        app.pressEnter()
        yield* app.waitFrame("Authorization pending", 3_000)
        app.pressKey("\t")
        app.pressKey("\t")
        yield* app.waitFrame("[d] Deny")
        app.pressKey("d")
        yield* app.waitFrame("Authorization denied", 20_000)
        yield* app.settled
        expect(yield* fileSystem.exists(path.join(app.workspace, "denied.txt"))).toBe(false)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
