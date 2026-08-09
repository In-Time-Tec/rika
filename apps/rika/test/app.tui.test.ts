import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect, FileSystem, Path } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const activeTimePattern = /◷ [0-9]+s/u
const tuiTestTimeout = 30_000

const spanHasColor = (app: TuiApp.TuiApp, text: string, color: string): boolean =>
  app
    .spans()
    .lines.flatMap((line) => line.spans)
    .some((span) => span.text.includes(text) && span.fg.toInts().join(",") === color)

test(
  "reloads a failed root with its completed subagent from durable state",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          /**
           * One level of delegation: a chain deeper than this cannot finish, because every Run in it
           * holds a scheduler slot at once and the middle agent's next turn waits on a slot its own
           * parent is holding. The root waits for the child whose completion it then asserts.
           */
          lanes: [
            {
              steps: [
                model.turn([model.spawnAndWait([{ profile: "Task", prompt: "Run top-level work." }], "top-agent")]),
                model.failure("ROOT_RELOAD_FAILED"),
              ],
            },
            { profile: "Task", steps: [model.text("TOP_LEVEL_RELOAD_COMPLETE")] },
          ],
        })

        yield* Effect.promise(() => app.type("Delegate nested work, then fail."))
        app.pressEnter()
        const turnId = Turn.TurnId.make("tui-turn-0")
        // The root fails only after the child it waited for has answered.
        yield* app.waitFrame("Execution failed", 25_000)
        yield* app.settled

        yield* app.reload
        const reloaded = yield* app.transcript(turnId)
        const entries = (reloaded?.units ?? []).flatMap((unit) =>
          unit.content._tag === "Entry" ? [unit.content.text] : [],
        )
        const statuses = (reloaded?.units ?? []).flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "ToolCall" ? [unit.content.block.status] : [],
        )
        const cards = (reloaded?.units ?? []).flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? [unit.content.block] : [],
        )
        expect(entries).toContain("TOP_LEVEL_RELOAD_COMPLETE")
        expect(cards.map(({ status }) => status)).toEqual(["complete"])
        expect(statuses).not.toContain("running")
        expect(statuses).not.toContain("failed")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "keeps accumulated usage visible after an attempt settles without usage",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              steps: [
                model.turn([model.part("PRICED_TURN_COMPLETE")], { inputTokens: 1_200, outputTokens: 340 }),
                model.failure("UNPRICED_TURN_FAILED"),
              ],
            },
          ],
        })

        yield* Effect.promise(() => app.type("Price this turn."))
        app.pressEnter()
        yield* app.waitFrame("PRICED_TURN_COMPLETE")
        yield* app.waitFrame("ctx")
        yield* app.clickText("ctx")
        const priced = yield* app.waitFrame("Used")
        expect(priced).toContain("1.2K")
        expect(priced).not.toContain("$\u2014")
        app.pressEscape()
        yield* app.waitGone("Used       ")

        yield* Effect.promise(() => app.type("Fail this turn."))
        app.pressEnter()
        yield* app.waitFrame("Execution failed")
        yield* app.settled
        yield* app.clickText("ctx")
        const settledFrame = yield* app.waitFrame("Used")
        expect(settledFrame).toContain("1.2K")
        expect(settledFrame).not.toContain("$\u2014")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "shows elapsed active time for the first turn of a new session",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({ script: [model.text("TIMER_COMPLETE", 1_500)] })

        yield* Effect.promise(() => app.type("Measure this turn."))
        app.pressEnter()
        yield* app.waitFrame("ctx")
        yield* app.clickText("ctx")
        yield* app.waitFrame("Active")
        const active = yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))
        expect(active).toMatch(/◷ [0-9]+s/u)
        expect(active).not.toContain("◷ ····")
        yield* app.waitFrame("TIMER_COMPLETE")
        yield* app.settled
        expect(yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))).toMatch(activeTimePattern)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "restores elapsed active time after reopening the persisted thread",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({
          directory: "/tmp",
          prefix: "rika-timer-reopen-",
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* TuiApp.tuiApp({
              root,
              workspaceFiles: { "timer.txt": "TIMER" },
              script: [
                model.turn([
                  model.binding({ module: "workspace", operation: "read", input: { path: "timer.txt" } }, "timer-read"),
                ]),
                model.text("PERSISTED_TIMER_COMPLETE", 1_500),
              ],
            })
            yield* Effect.promise(() => app.type("Persist this timer."))
            app.pressEnter()
            yield* app.waitFrame("ctx")
            yield* app.clickText("ctx")
            yield* app.waitFrame("Active")
            yield* app.waitFrame("PERSISTED_TIMER_COMPLETE")
            yield* app.settled
            const settledFrame = yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))
            expect(settledFrame).toMatch(activeTimePattern)
            yield* app.quit
          }),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* TuiApp.tuiApp({ root, initialThreadId: "tui-thread-0", idStart: 10, script: [] })
            yield* app.waitFrame("ctx")
            yield* app.clickText("ctx")
            yield* app.waitFrame("Active")
            const restoredFrame = yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))
            const restored = restoredFrame.match(activeTimePattern)![0]
            expect(restored).not.toBe("◷ —")
            expect(restoredFrame).toContain(restored)
            yield* app.quit
          }),
        )
      }),
    ),
  tuiTestTimeout,
)

test(
  "renders the Oracle label and nested tool output through the real app stack",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "nested.txt": "NESTED_TOOL_CONTENT" },
          lanes: [
            {
              steps: [
                model.turn([
                  model.spawnAndWait([{ profile: "Oracle", prompt: "Read the nested fixture." }], "oracle-style"),
                ]),
                model.text("ROOT_STYLE_RESULT"),
              ],
            },
            {
              profile: "Oracle",
              steps: [
                model.turn([
                  model.binding(
                    { module: "workspace", operation: "read", input: { path: "nested.txt" } },
                    "nested-read",
                  ),
                ]),
                model.text("## Oracle result\n\n**ORACLE_STYLE_RESULT**"),
              ],
            },
          ],
        })

        yield* Effect.promise(() => app.type("Ask Oracle to inspect the fixture."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_STYLE_RESULT", 25_000)
        yield* app.settled
        // Two rows expand now: the cell that spawned the child, then the child's card. Selecting the
        // card is one Tab past the cell, and a card opens on Enter rather than on selection.
        yield* app.waitFrame("Oracle has spoken")
        app.pressKey("\t")
        app.pressKey("\t")
        app.pressEnter()
        const nestedCell = 'ts await rika.workspace.read({"path":"nested.txt"}) \u00b7 1 line'
        yield* app.waitFrame(nestedCell)
        yield* app.settled
        const completed = app.frame()
        expect(completed.match(/Oracle has spoken/g) ?? []).toHaveLength(1)
        expect(completed.split(nestedCell)).toHaveLength(2)
        expect(completed).toContain("Oracle result")
        expect(completed).toContain("ORACLE_STYLE_RESULT")
        expect(completed).not.toContain("## Oracle result")
        expect(completed).not.toContain("The subagent finished without a final message.")
        expect(completed).not.toContain("Collected subagents")
        expect(completed).not.toContain("Waiting for subagents")
        expect(spanHasColor(app, nestedCell, "192,192,192,255"), "nested cell summary span").toBe(true)
        expect(spanHasColor(app, "\u251c ", "128,128,128,255"), "nested cell branch span").toBe(true)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "keeps nested Agent prompts, tools, and final output aligned through collapse and expand",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          workspaceFiles: { "nested.txt": "NESTED_TOOL_CONTENT" },
          /**
           * One level of delegation, so the child does its own work in its own cell rather than
           * delegating again: a deeper chain holds every slot the scheduler has and never finishes.
           */
          lanes: [
            {
              steps: [
                model.turn([model.spawnAndWait([{ profile: "Task", prompt: "PARENT_AGENT_PROMPT" }], "parent-agent")]),
                model.text("ROOT_AGENT_FINAL"),
              ],
            },
            {
              profile: "Task",
              steps: [
                model.turn([
                  model.binding(
                    { module: "workspace", operation: "read", input: { path: "nested.txt" } },
                    "nested-read",
                  ),
                ]),
                model.text("PARENT_AGENT_FINAL"),
              ],
            },
          ],
          width: 80,
          height: 64,
        })

        yield* Effect.promise(() => app.type("ROOT_USER_PROMPT"))
        app.pressEnter()
        yield* app.waitFrame("ROOT_AGENT_FINAL")
        yield* app.settled

        const durable = yield* app.transcript(Turn.TurnId.make("tui-turn-0"))
        const units = durable?.units ?? []
        const card = (name: string) =>
          units.find(
            (unit) =>
              unit.content._tag === "Block" &&
              unit.content.block._tag === "SubagentCard" &&
              unit.content.block.name === name,
          )
        const parentCard = card("Task")
        const parentId =
          parentCard?.content._tag === "Block" && parentCard.content.block._tag === "SubagentCard"
            ? parentCard.content.block.id
            : undefined
        expect(parentId, "parent SubagentCard").toBeDefined()
        const cardUnit = (childId: string | undefined) =>
          units.find(
            (unit) =>
              unit.content._tag === "Block" &&
              unit.content.block._tag === "SubagentCard" &&
              unit.content.block.id === childId,
          )
        const cellOwning = (childId: string | undefined) =>
          units.find(
            (unit) =>
              unit.content._tag === "Block" &&
              unit.content.block._tag === "Cell" &&
              unit.content.block.id === cardUnit(childId)?.parentId,
          )
        expect(cellOwning(parentId), "the root cell that spawned Task").toBeDefined()
        const owner = (text: string) =>
          units.find((unit) => unit.content._tag === "Entry" && unit.content.text.includes(text))?.parentId
        expect(owner("PARENT_AGENT_FINAL")).toBe(parentId)
        expect(owner("ROOT_AGENT_FINAL")).toBeUndefined()
        const nestedReadCell = units.find(
          (unit) =>
            unit.content._tag === "Block" &&
            unit.content.block._tag === "Cell" &&
            unit.content.block.source.text.includes("nested.txt"),
        )
        expect(nestedReadCell?.parentId).toBe(parentId)

        // The spawning cell is the first expandable row now, so the card is one Tab further on.
        app.pressKey("\t")
        app.pressKey("\t")
        app.pressEnter()
        const expanded = yield* app.waitFrame("PARENT_AGENT_PROMPT")
        expect(expanded).toContain("PARENT_AGENT_FINAL")
        expect(expanded.match(/ROOT_USER_PROMPT/g) ?? []).toHaveLength(1)
        expect(expanded.match(/PARENT_AGENT_PROMPT/g) ?? []).toHaveLength(1)
        app.pressEnter()
        const collapsed = yield* app.waitGone("PARENT_AGENT_PROMPT")
        expect(collapsed).toContain("ROOT_AGENT_FINAL")
        app.pressEnter()
        const reexpanded = yield* app.waitFrame("PARENT_AGENT_PROMPT")
        expect(reexpanded.match(/PARENT_AGENT_PROMPT/g) ?? []).toHaveLength(1)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "distinguishes reporting, working, and failed subagents in the transcript",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "silent.txt": "SILENT_TOOL_BODY" },
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Task", prompt: "REPORTING_AGENT_PROMPT" }], "reporting-agent")]),
                model.text("ROOT_AFTER_REPORT"),
                model.turn([model.spawn([{ profile: "Task", prompt: "TOOL_ONLY_AGENT_PROMPT" }], "tool-only-agent")]),
                model.text("ROOT_AFTER_TOOL_ONLY"),
                model.turn([model.spawn([{ profile: "Task", prompt: "FAILING_AGENT_PROMPT" }], "failing-agent")]),
                model.text("ROOT_AFTER_FAILURE"),
              ],
            },
            {
              profile: "Task",
              steps: [
                model.text("REPORTING_AGENT_FINDING"),
                model.turn([
                  model.binding(
                    { module: "workspace", operation: "read", input: { path: "silent.txt" } },
                    "silent-read",
                  ),
                ]),
                model.text("SILENT_AGENT_TOOL_ONLY"),
                model.failure("CHILD_STREAM_FAILED"),
              ],
            },
          ],
          width: 100,
          height: 64,
        })

        const delegate = (prompt: string, marker: string) =>
          Effect.gen(function* () {
            yield* Effect.promise(() => app.type(prompt))
            app.pressEnter()
            yield* app.waitFrame(marker)
          })

        yield* delegate("Delegate work that reports back.", "ROOT_AFTER_REPORT")
        // The spawning cell is the first expandable row now, so the card is one Tab further on.
        app.pressKey("\t")
        app.pressKey("\t")
        app.pressEnter()
        yield* app.waitFrame("REPORTING_AGENT_FINDING")
        // A spawn admits without waiting, so the parent answers while its child is still working.
        // The card reaches its terminal label on the child's own schedule, not the parent's.
        yield* app.waitFrame("Subagent finished")

        yield* delegate("Delegate work that works before reporting.", "ROOT_AFTER_TOOL_ONLY")
        const worked = yield* app.waitFrameMatch((frame) => (frame.match(/Subagent finished/g) ?? []).length === 2)
        expect(worked.match(/Subagent failed/g) ?? []).toHaveLength(0)

        yield* delegate("Delegate work that fails outright.", "ROOT_AFTER_FAILURE")
        const failed = yield* app.waitFrameMatch((frame) => (frame.match(/Subagent failed/g) ?? []).length === 1)
        expect(failed.match(/Subagent finished/g) ?? []).toHaveLength(2)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "settles repeated process waits while the launching cell owns process liveness",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const command = "printf EARLY_OUTPUT; sleep 1; printf FINAL_OUTPUT"
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          script: [
            model.turn([
              model.binding(
                { module: "processes", operation: "start", input: { command, timeoutMillis: 0 } },
                "bash-wait",
              ),
            ]),
            model.turn([
              model.binding(
                { module: "processes", operation: "status", input: { processId: "1", waitMillis: 0 } },
                "wait-immediate",
              ),
            ]),
            model.turn([
              model.binding(
                { module: "processes", operation: "status", input: { processId: "1", waitMillis: 10_000 } },
                "wait-final",
              ),
            ]),
            model.text("SHELL_WAIT_COMPLETE"),
          ],
        })

        yield* Effect.promise(() => app.type("Run the process and wait for it."))
        app.pressEnter()
        yield* app.waitFrame("SHELL_WAIT_COMPLETE", 20_000)
        yield* app.settled

        const cells = (yield* app.transcript(Turn.TurnId.make("tui-turn-0")))?.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "Cell" ? [unit.content.block] : [],
        )
        expect(cells?.map(({ source }) => source.text)).toEqual([
          `await rika.processes.start({"command":"${command}","timeoutMillis":0})`,
          'await rika.processes.status({"processId":"1","waitMillis":0})',
          'await rika.processes.status({"processId":"1","waitMillis":10000})',
        ])
        expect(cells?.at(0)?.result, "the launching cell reports the registered process").toContain('processId: "1"')
        expect(cells?.at(0)?.result, "the launching cell leaves the process running").toContain("running: true")
        expect(cells?.at(1)?.result).toContain("EARLY_OUTPUT")
        expect(cells?.at(1)?.result, "the immediate wait observes a live process").toContain("running: true")
        expect(cells?.at(2)?.result).toContain("FINAL_OUTPUT")
        expect(cells?.at(2)?.result, "the final wait observes a settled process").toContain("running: false")
        expect(cells?.at(2)?.result, "the settled process reports its exit code").toContain("exitCode: 0")
        expect(cells?.every(({ status }) => status === "complete")).toBe(true)

        app.pressKey("\t")
        app.pressEnter()
        const completed = yield* app.waitFrame("FINAL_OUTPUT", 20_000)
        expect(completed).not.toContain("Waited for")
        expect(completed).not.toContain("Waiting for")
        // A cell shows its own source, and the launching cell's result echoes the command it ran,
        // so the command appears once per cell that names it rather than once in the frame.
        expect(completed.match(/printf EARLY_OUTPUT; sleep 1; printf FINAL_OUTPUT/g) ?? []).toHaveLength(2)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "runs turns, tools, pickers, and surfaces in one real TUI session",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "src/alpha.ts": "alpha", "src/beta.ts": "beta", "README.md": "readme" },
          script: [
            model.text("HARNESS_RESPONSE"),
            model.turn([
              model.binding(
                { module: "processes", operation: "start", input: { command: "printf TOOL_OK" } },
                "ordinary-tool",
              ),
            ]),
            model.text("ORDINARY_COMPLETE"),
            model.text("MENTION_COMPLETE"),
          ],
        })
        yield* Effect.promise(() => app.type("Say hello."))
        app.pressEnter()
        const first = yield* app.waitFrame("HARNESS_RESPONSE")
        expect(first).toContain("Say hello.")
        yield* app.settled

        yield* Effect.promise(() => app.type("Run an ordinary tool."))
        app.pressEnter()
        const ordinary = yield* app.waitFrame("ORDINARY_COMPLETE")
        expect(ordinary).toContain("printf TOOL_OK")
        expect(ordinary).not.toContain("Allow once")
        expect(ordinary).not.toContain("[pending]")
        yield* app.settled

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
        yield* app.settled

        app.pressKey("t", { alt: true })
        const tree = yield* app.waitFrame("Files (3)")
        expect(tree).toContain("src/")
        expect(tree).toContain("alpha.ts")
        expect(tree).toContain("README.md")
        app.pressKey("t", { alt: true })
        yield* app.waitGone("Files (")

        app.pressKey("s", { ctrl: true })
        yield* app.waitFrame("Balanced default for everyday work")
        app.pressArrow("right")
        yield* app.waitFrame("Deep reasoning for hard tasks")
        app.pressEscape()
        const escaped = yield* app.waitGone("Deep reasoning")
        expect(escaped).toContain("medium")
        app.pressKey("s", { ctrl: true })
        yield* app.waitFrame("Balanced default for everyday work")
        app.pressArrow("right")
        yield* app.waitFrame("Deep reasoning for hard tasks")
        app.pressEnter()
        yield* app.waitGone("Deep reasoning")
        expect(yield* app.waitFrame("high")).toContain("high")

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
  tuiTestTimeout,
)

test(
  "runs shell input immediately without permission prompts",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({ script: [] })

        yield* Effect.promise(() => app.type("$printf '\\101\\114\\114\\117\\127\\105\\104'"))
        app.pressEnter()
        const allowed = yield* app.waitFrame("ALLOWED")
        expect(allowed).not.toContain("Run shell command")
        expect(allowed).not.toContain("Allow once")
        expect(allowed).not.toContain("Deny")

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

test(
  "delegates two levels deep, each level using a tool",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        // Delegation depth was thought to be bounded by scheduler slots. It was not: a child died on
        // its own session identity, and the arithmetic that seemed to explain it described the
        // symptom. This holds the real depth open so a regression reads as one.
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "deep.txt": "DEEP_BODY" },
          lanes: [
            {
              steps: [
                model.turn([model.spawnAndWait([{ profile: "Task", prompt: "L1" }], "l1", 25_000)]),
                model.text("ROOT_DEEP_DONE"),
              ],
            },
            {
              profile: "Task",
              steps: [
                model.turn([model.spawnAndWait([{ profile: "Oracle", prompt: "L2" }], "l2", 20_000)]),
                model.text("CHILD_DEEP_DONE"),
              ],
            },
            {
              profile: "Oracle",
              steps: [
                model.turn([
                  model.binding({ module: "workspace", operation: "read", input: { path: "deep.txt" } }, "deep-read"),
                ]),
                model.text("GRANDCHILD_DONE"),
              ],
            },
          ],
          height: 48,
        })
        yield* Effect.promise(() => app.type("Delegate deep work."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_DEEP_DONE", 30_000)
        yield* app.settled
        expect(app.frame()).toContain("Subagent finished")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
