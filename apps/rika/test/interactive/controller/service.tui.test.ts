import { expect, test } from "vitest"
import { Effect, FileSystem, Path } from "effect"
import * as Turn from "@rika/product/turn-record"
import * as TuiApp from "../../support/tui-app.harness"
import { model } from "../../support/tui-model.fixture"

const tuiTestTimeout = 60_000

test(
  "renders one answer across the preview-to-durable handoff while the turn continues",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const answer = "HANDOFF_ANSWER_ONCE"
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          script: [
            model.turn([model.part(answer), model.tool("bash", { command: "sleep 2" }, "handoff-sleep")]),
            model.text("HANDOFF_FINAL_ONCE"),
          ],
        })

        yield* Effect.tryPromise(() => app.type("Exercise the model response handoff."))
        app.pressEnter()
        const durable = yield* app.waitTranscript(Turn.TurnId.make("tui-turn-0"), (projection) =>
          projection.units.some(
            (unit) =>
              unit.content._tag === "Entry" && unit.content.role === "assistant" && unit.content.text === answer,
          ),
        )
        const duringTool = yield* app.waitFrame(answer)

        expect(duringTool.match(new RegExp(answer, "g")) ?? []).toHaveLength(1)
        expect(
          durable.units.filter(
            (unit) =>
              unit.content._tag === "Entry" && unit.content.role === "assistant" && unit.content.text === answer,
          ),
        ).toHaveLength(1)
        const completed = yield* app.waitFrame("HANDOFF_FINAL_ONCE", 20_000)
        expect(completed.match(/HANDOFF_FINAL_ONCE/g) ?? []).toHaveLength(1)
        const settled = yield* app.settled
        expect(settled).not.toContain("Waiting")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

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
            model.turn([model.tool("read", { path: "notes.txt" }, "approved-read")]),
            model.turn([model.part("APPROVAL_COMPLETE")], { inputTokens: 10_000, outputTokens: 100 }),
            model.turn([model.tool("bash", { command: "printf CANCEL_PROOF > cancel-proof.txt" }, "cancelled-tool")]),
            model.text("BASH_COMPLETE"),
          ],
        })

        yield* Effect.tryPromise(() => app.type("Read the notes file."))
        app.pressEnter()
        const completed = yield* app.waitFrame("APPROVAL_COMPLETE")
        expect(completed).not.toContain("[pending]")
        expect(completed).not.toContain("Allow once")
        const idleContext = yield* app.waitFrame("ctx")
        expect(idleContext).toMatch(/ctx [ᗧᗤ]/u)
        yield* app.clickText("ctx")
        const details = yield* app.waitFrame("Active")
        expect(details).toMatch(/[ᗧᗤ]·+/u)
        yield* app.pressPageUp
        expect(app.frame()).toBe(details)
        expect(yield* app.waitFrame("◷ ")).toMatch(/◷ [0-9]+s/u)
        yield* app.settled
        expect(app.frame()).toMatch(/◷ [0-9]+s/u)

        yield* app.clickComposer
        yield* Effect.tryPromise(() => app.type("Run the shell tool."))
        expect(app.frame()).not.toContain("Context & Usage")
        app.pressEnter()
        expect(yield* app.waitFrame("Waiting")).toMatch(/ctx [ᗧᗤ]/u)
        const shellCompleted = yield* app.waitFrame("BASH_COMPLETE")
        expect(shellCompleted).toMatch(/ctx [ᗧᗤ]/u)
        expect(shellCompleted).not.toContain("[pending]")
        expect(shellCompleted).not.toContain("Allow once")
        expect(yield* fileSystem.exists(path.join(app.workspace, "cancel-proof.txt"))).toBe(true)

        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "applies edits in the selected workspace without presenting unsupported authorization controls",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          height: 44,
          workspaceFiles: { "edited.txt": "ORIGINAL", "untouched.txt": "ORIGINAL" },
          script: [
            model.turn([
              model.tool("edit", { path: "edited.txt", old_str: "ORIGINAL", new_str: "EDITED_BODY" }, "edit-file"),
            ]),
            model.text("EDIT_WRITE_COMPLETE"),
          ],
        })

        yield* Effect.tryPromise(() => app.type("Edit the selected file."))
        app.pressEnter()
        const completed = yield* app.waitFrame("EDIT_WRITE_COMPLETE", 20_000)
        expect(completed).not.toContain("Authorization pending")
        expect(completed).not.toContain("[a] Approve")
        expect(completed).not.toContain("[d] Deny")
        yield* app.settled
        expect(yield* fileSystem.readFileString(path.join(app.workspace, "edited.txt"))).toBe("EDITED_BODY")
        expect(yield* fileSystem.readFileString(path.join(app.workspace, "untouched.txt"))).toBe("ORIGINAL")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
