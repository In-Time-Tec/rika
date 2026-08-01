import { expect, test } from "vitest"
import { Theme } from "@rika/tui"
import { Deferred, Effect, FileSystem, Path } from "effect"
import * as TuiApp from "./tui-app"

const activeTimePattern = /◷ [0-9]+s/u

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
          lanes: [
            {
              script: [
                TuiApp.model.toolCall("task", { prompt: "Run top-level work." }, "top-agent"),
                TuiApp.model.toolCall("await_subagents", {}, "root-join"),
                TuiApp.model.failure("ROOT_RELOAD_FAILED"),
              ],
            },
            {
              when: (prompt) => prompt.includes("Run nested work.") && !prompt.includes("Run top-level work."),
              script: [TuiApp.model.text("NESTED_RELOAD_COMPLETE")],
            },
            {
              when: (prompt) => !prompt.includes("Delegate nested work, then fail."),
              script: [
                TuiApp.model.toolCall("review", { prompt: "Run nested work." }, "nested-agent"),
                TuiApp.model.toolCall("await_subagents", {}, "top-join"),
                TuiApp.model.text("TOP_LEVEL_RELOAD_COMPLETE"),
              ],
            },
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
        expect(nested).not.toMatch(/:\d+ (?:working|finished|failed)/)
        expect(nested).not.toContain("Running 1 subagent")
        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "marks the total unknown when an unpriced attempt follows a priced attempt",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [TuiApp.model.text("PRICED_TURN_COMPLETE"), TuiApp.model.failure("UNPRICED_TURN_FAILED")],
          mapExecutionEvent: (event) =>
            event.type === "model.attempt.completed"
              ? { ...event, data: { ...event.data, cost: { amount: 0, currency: "USD" } } }
              : event,
        })

        yield* Effect.promise(() => app.type("Price this turn."))
        app.pressEnter()
        yield* app.waitFrame("PRICED_TURN_COMPLETE")
        const priced = yield* app.waitCost
        expect(priced.match(/\$[0-9][^ ]*/u)?.[0]).toBe("$0.00")
        expect(priced).not.toContain("$\u2014")

        yield* Effect.promise(() => app.type("Fail this turn."))
        app.pressEnter()
        yield* app.waitFrame("UNPRICED_TURN_FAILED")
        yield* app.settled
        const settledFrame = yield* app.waitFrame("$\u2014")
        expect(settledFrame).not.toMatch(/\$[0-9]/u)
        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "shows elapsed active time for the first turn of a new session",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({ script: [TuiApp.model.text("TIMER_COMPLETE", 1_500)] })

        yield* Effect.promise(() => app.type("Measure this turn."))
        app.pressEnter()
        yield* app.waitFrame("$")
        yield* app.clickText("$")
        yield* app.waitFrame("tok")
        yield* app.clickText("tok")
        const active = yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))
        expect(active).toMatch(/◷ [0-9]+s/u)
        expect(active).not.toContain("◷ ····")
        yield* app.waitFrame("TIMER_COMPLETE")
        yield* app.settled
        expect(yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))).toMatch(activeTimePattern)
        yield* app.quit
      }),
    ),
  240_000,
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
                TuiApp.model.turn([TuiApp.model.toolCall("read", { path: "timer.txt" }, "timer-read")]),
                TuiApp.model.text("PERSISTED_TIMER_COMPLETE", 1_500),
              ],
            })
            yield* Effect.promise(() => app.type("Persist this timer."))
            app.pressEnter()
            yield* app.waitFrame("$")
            yield* app.clickText("$")
            yield* app.waitFrame("tok")
            yield* app.clickText("tok")
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
            yield* app.waitFrame("$")
            yield* app.clickText("$")
            yield* app.waitFrame("tok")
            yield* app.clickText("tok")
            const restoredFrame = yield* app.waitFrameMatch((frame) => activeTimePattern.test(frame))
            const restored = restoredFrame.match(activeTimePattern)![0]
            expect(restored).not.toBe("◷ —")
            expect(restoredFrame).toContain(restored)
            yield* app.quit
          }),
        )
      }),
    ),
  240_000,
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
              script: [
                TuiApp.model.toolCall("oracle", { prompt: "Read the nested fixture." }, "oracle-style"),
                TuiApp.model.toolCall("await_subagents", {}, "root-join"),
                TuiApp.model.text("ROOT_STYLE_RESULT"),
              ],
            },
            {
              when: (prompt) => !prompt.includes("Ask Oracle to inspect the fixture."),
              script: [
                TuiApp.model.toolCall("read", { path: "nested.txt" }, "nested-read"),
                TuiApp.model.text("## Oracle result\n\n**ORACLE_STYLE_RESULT**"),
              ],
            },
          ],
        })

        yield* Effect.promise(() => app.type("Ask Oracle to inspect the fixture."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_STYLE_RESULT")
        yield* app.settled
        app.pressKey("\t")
        yield* app.waitFrame("Oracle has spoken")
        app.pressEnter()
        yield* app.waitFrame("Read nested.txt")
        yield* app.settled
        const completed = app.frame()
        expect(completed.match(/Oracle has spoken/g) ?? []).toHaveLength(1)
        expect(completed.match(/Read nested\.txt/g) ?? []).toHaveLength(1)
        expect(completed).toContain("Oracle result")
        expect(completed).toContain("ORACLE_STYLE_RESULT")
        expect(completed).not.toContain("## Oracle result")
        expect(completed).not.toContain("The subagent finished without a final message.")
        expect(completed).not.toContain("Collected subagents")
        expect(completed).not.toContain("Waiting for subagents")
        expect(spanHasColor(app, "Read", Theme.colors.text), "Read primary span").toBe(true)
        expect(spanHasColor(app, " nested.txt", Theme.colors.muted), "Read path span").toBe(true)
        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "keeps nested Agent prompts, tools, and final output aligned through collapse and expand",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "nested.txt": "NESTED_TOOL_CONTENT" },
          lanes: [
            {
              script: [
                TuiApp.model.toolCall("task", { prompt: "PARENT_AGENT_PROMPT" }, "parent-agent"),
                TuiApp.model.toolCall("await_subagents", {}, "root-join"),
                TuiApp.model.text("ROOT_AGENT_FINAL"),
              ],
            },
            {
              when: (prompt) => prompt.includes("NESTED_AGENT_PROMPT") && !prompt.includes("PARENT_AGENT_PROMPT"),
              script: [
                TuiApp.model.toolCall("read", { path: "nested.txt" }, "nested-read"),
                TuiApp.model.text("NESTED_AGENT_FINAL"),
              ],
            },
            {
              when: (prompt) => !prompt.includes("ROOT_USER_PROMPT"),
              script: [
                TuiApp.model.toolCall("review", { prompt: "NESTED_AGENT_PROMPT" }, "nested-agent"),
                TuiApp.model.toolCall("await_subagents", {}, "parent-join"),
                TuiApp.model.text("PARENT_AGENT_FINAL"),
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
        app.pressKey("\t")
        app.pressEnter()
        yield* app.waitFrame("PARENT_AGENT_PROMPT")
        app.pressKey("\t")
        app.pressEnter()
        let expanded = yield* app.waitFrame("NESTED_AGENT_FINAL")
        const assertTree = (frame: string) => {
          const lines = frame.split("\n")
          const rootRow = lines.findIndex((line) => line.includes("ROOT_USER_PROMPT"))
          const parentPromptRow = lines.findIndex((line) => line.includes("PARENT_AGENT_PROMPT"))
          const nestedHeaderRow = lines.findIndex(
            (line, index) => index > parentPromptRow && line.includes("Reviewed code"),
          )
          const nestedHeader = nestedHeaderRow < 0 ? undefined : lines[nestedHeaderRow]
          const nestedPrompt = lines.find((line) => line.includes("NESTED_AGENT_PROMPT"))
          const nestedTool = lines.find((line) => line.includes("Read nested.txt"))
          const nestedFinal = lines.find((line) => line.includes("NESTED_AGENT_FINAL"))
          expect(rootRow).toBeGreaterThan(-1)
          expect(parentPromptRow).toBeGreaterThan(rootRow)
          expect(nestedHeader, frame).toBeDefined()
          expect(nestedTool, frame).toBeDefined()
          expect(nestedHeader?.indexOf("├")).toBe(parentPromptRow < 0 ? -1 : lines[parentPromptRow]?.indexOf("P"))
          expect(nestedPrompt?.indexOf("│")).toBe(nestedHeader?.indexOf("├"))
          expect(nestedTool?.indexOf("├")).toBe(nestedPrompt?.indexOf("N"))
          expect(nestedFinal?.indexOf("╰")).toBe(nestedPrompt?.indexOf("N"))
          expect(frame.match(/ROOT_USER_PROMPT/g) ?? []).toHaveLength(1)
          expect(frame.match(/NESTED_AGENT_PROMPT/g) ?? []).toHaveLength(1)
        }
        assertTree(expanded)

        app.pressEnter()
        yield* app.waitGone("NESTED_AGENT_FINAL")
        app.pressEnter()
        expanded = yield* app.waitFrame("NESTED_AGENT_FINAL")
        assertTree(expanded)
        yield* app.quit
      }),
    ),
  240_000,
)

test(
  "distinguishes a reported, an unreported, and a failed subagent in the transcript",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              script: [
                TuiApp.model.toolCall("task", { prompt: "REPORTING_AGENT_PROMPT" }, "reporting-agent"),
                TuiApp.model.toolCall("await_subagents", {}, "join-report"),
                TuiApp.model.text("ROOT_AFTER_REPORT"),
                TuiApp.model.toolCall("task", { prompt: "SILENT_AGENT_PROMPT" }, "silent-agent"),
                TuiApp.model.toolCall("await_subagents", {}, "join-silent"),
                TuiApp.model.text("ROOT_AFTER_NO_REPORT"),
                TuiApp.model.toolCall("task", { prompt: "FAILING_AGENT_PROMPT" }, "failing-agent"),
                TuiApp.model.toolCall("await_subagents", {}, "join-failure"),
                TuiApp.model.text("ROOT_AFTER_FAILURE"),
              ],
            },
            {
              when: (prompt) => prompt.includes("REPORTING_AGENT_PROMPT") && !prompt.includes("reports back"),
              script: [TuiApp.model.text("REPORTING_AGENT_FINDING")],
            },
            {
              when: (prompt) => prompt.includes("SILENT_AGENT_PROMPT") && !prompt.includes("reports nothing"),
              script: [TuiApp.model.turn([])],
            },
            {
              when: (prompt) => prompt.includes("FAILING_AGENT_PROMPT") && !prompt.includes("fails outright"),
              script: [TuiApp.model.failure("CHILD_STREAM_FAILED")],
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
            yield* app.settled
          })

        yield* delegate("Delegate work that reports back.", "ROOT_AFTER_REPORT")
        app.pressKey("\t")
        app.pressEnter()
        const reported = yield* app.waitFrame("REPORTING_AGENT_FINDING")
        expect(reported).toContain("Subagent finished")

        yield* delegate("Delegate work that reports nothing.", "ROOT_AFTER_NO_REPORT")
        const unreported = app.frame()
        expect(unreported.match(/Subagent finished/g) ?? []).toHaveLength(1)
        expect(unreported.match(/Subagent failed/g) ?? []).toHaveLength(1)

        yield* delegate("Delegate work that fails outright.", "ROOT_AFTER_FAILURE")
        const failed = app.frame()
        expect(failed.match(/Subagent failed/g) ?? []).toHaveLength(2)
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
        yield* app.settled
        app.pressKey("\t")
        app.pressEnter()
        const completed = yield* app.waitFrame("FINAL_OUTPUT")
        expect(completed).not.toContain("Waited for")
        expect(completed).not.toContain("Waiting for")
        expect(completed).not.toContain("Running 1 tool")
        expect(completed).toContain("EARLY_OUTPUTFINAL_OUTPUT")
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
  240_000,
)

test(
  "runs durable tools immediately without approval prompts",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const app = yield* TuiApp.tuiApp({
          workspaceFiles: { "notes.txt": "APPROVAL_NOTES" },
          script: [
            TuiApp.model.turn([TuiApp.model.toolCall("read", { path: "notes.txt" }, "approved-read")]),
            TuiApp.model.text("APPROVAL_COMPLETE"),
            TuiApp.model.turn([
              TuiApp.model.toolCall("bash", { command: "printf CANCEL_PROOF > cancel-proof.txt" }, "cancelled-tool"),
            ]),
            TuiApp.model.text("BASH_COMPLETE"),
          ],
        })

        yield* Effect.promise(() => app.type("Read the notes file."))
        app.pressEnter()
        const completed = yield* app.waitFrame("APPROVAL_COMPLETE")
        expect(completed).not.toContain("[pending]")
        expect(completed).not.toContain("Allow once")
        yield* app.clickText("$")
        yield* app.waitFrame("tok")
        yield* app.clickText("tok")
        expect(yield* app.waitFrame("◷ ")).toMatch(/◷ [0-9]+s/u)
        yield* app.settled
        expect(app.frame()).toMatch(/◷ [0-9]+s/u)

        yield* Effect.promise(() => app.type("Run the shell tool."))
        app.pressEnter()
        const shellCompleted = yield* app.waitFrame("BASH_COMPLETE")
        expect(shellCompleted).not.toContain("[pending]")
        expect(shellCompleted).not.toContain("Allow once")
        expect(yield* fileSystem.exists(path.join(app.workspace, "cancel-proof.txt"))).toBe(true)

        yield* app.quit
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
        yield* app.waitModelRequests(1)
        app.close()
        const restored = yield* app.waitFrame("│ Restore this submitted prompt.")
        expect(restored).not.toContain("⊘")
        expect(restored).not.toContain("cancelled")
        yield* Effect.promise(() => app.type(" again"))
        app.pressEnter()
        yield* app.waitFrame("RESTORED_PROMPT_SENT")
        yield* app.settled
        app.close()
        yield* app.done
      }),
    ),
  240_000,
)

test(
  "echoes a queued prompt beside the streaming turn and drains it without a restart",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          script: [TuiApp.model.text("SLOW_FIRST_ANSWER", 5_000), TuiApp.model.text("QUEUED_SECOND_ANSWER")],
        })
        yield* Effect.promise(() => app.type("First slow prompt."))
        app.pressEnter()
        yield* app.waitFrame("First slow prompt.")
        yield* app.waitModelRequests(1)
        yield* Effect.promise(() => app.type("Second queued prompt."))
        app.pressEnter()
        const queuedFrame = yield* app.waitFrame("Second queued prompt.")
        expect(queuedFrame).toContain("First slow prompt.")
        const finalFrame = yield* app.waitFrame("QUEUED_SECOND_ANSWER")
        expect(finalFrame).toContain("SLOW_FIRST_ANSWER")
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
        yield* app.waitModelRequests(1)
        app.pressKey("c", { ctrl: true })
        const promoted = yield* app.waitFrame("QUEUED_DONE")
        expect(promoted).not.toContain("LATE_QUEUE_HEAD")
        expect(promoted).not.toContain("\u2298")
        expect(promoted).not.toContain("Execution failed")
        expect(promoted).not.toContain("wait cancelled")
        expect(promoted).not.toContain("! cancelled")
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
        yield* app.settled
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
  "reports rebuild progress while a legacy thread refolds and clears it once the projection lands",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped({ directory: "/tmp", prefix: "rika-refold-" })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* TuiApp.tuiApp({ root, script: [TuiApp.model.text("LEGACY_TURN_COMPLETE")] })
            yield* Effect.promise(() => app.type("Persist a legacy turn."))
            app.pressEnter()
            yield* app.waitFrame("LEGACY_TURN_COMPLETE")
            yield* app.settled
            yield* app.quit
          }),
        )

        expect(yield* TuiApp.makeProjectionsLegacy(root)).toContain("tui-turn-0")
        const held = yield* Deferred.make<void>()

        yield* Effect.scoped(
          Effect.gen(function* () {
            const app = yield* TuiApp.tuiApp({
              root,
              initialThreadId: "tui-thread-0",
              idStart: 10,
              script: [],
              holdExecutionFollows: held,
            })
            const rebuilding = yield* app.waitFrame("Rebuilding thread projection")
            expect(rebuilding).toContain("Persist a legacy turn.")
            yield* Deferred.succeed(held, undefined)
            const rebuilt = yield* app.waitGone("Rebuilding thread projection")
            expect(rebuilt).toContain("LEGACY_TURN_COMPLETE")
            yield* app.quit
          }),
        )
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
  240_000,
)
