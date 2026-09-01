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
            model.turn([
              model.part(answer),
              model.binding(
                { module: "processes", operation: "start", input: { command: "sleep 2" } },
                "handoff-sleep",
              ),
            ]),
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
            model.turn([
              model.binding({ module: "workspace", operation: "read", input: { path: "notes.txt" } }, "approved-read"),
            ]),
            model.turn([model.part("APPROVAL_COMPLETE")], { inputTokens: 10_000, outputTokens: 100 }),
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

// Rika provides no Approvals service, so Generalist approves every declared capability without asking
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

        yield* Effect.tryPromise(() => app.type("Write the approved file."))
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
        yield* Effect.tryPromise(() => app.type("Write the denied file."))
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
