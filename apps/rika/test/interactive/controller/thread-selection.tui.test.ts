import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "../../support/tui-app.harness"
import { model } from "../../support/tui-model.fixture"

const tuiTestTimeout = 60_000

const spanHasColor = (app: TuiApp.TuiApp, text: string, color: string): boolean =>
  app
    .spans()
    .lines.flatMap((line) => line.spans)
    .some((span) => span.text.includes(text) && span.fg.toInts().join(",") === color)

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
                model.turn([model.spawn([{ profile: "Oracle", prompt: "Read the nested fixture." }], "oracle-style")]),
                model.text("ROOT_STYLE_RESULT"),
                model.text("ROOT_STYLE_SETTLEMENT_ACKNOWLEDGED"),
                model.text("ROOT_STYLE_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            {
              profile: "Oracle",
              steps: [
                model.turn([model.tool("read", { path: "nested.txt" }, "nested-read")]),
                model.text("## Oracle result\n\n**ORACLE_STYLE_RESULT**"),
              ],
            },
          ],
        })

        yield* Effect.tryPromise(() => app.type("Ask Oracle to inspect the fixture."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_STYLE_RESULT", 25_000)
        yield* app.settled
        // The root card opens first. Its nested read is the next selectable row.
        yield* app.waitFrame("Oracle has spoken")
        app.pressKey("\t")
        app.pressKey("\t")
        app.pressEnter()
        const nestedTool = "Read nested.txt"
        yield* app.waitFrame(nestedTool)
        app.pressKey("\t")
        app.pressEnter()
        yield* app.waitFrame("NESTED_TOOL_CONTENT")
        yield* app.settled
        const completed = app.frame()
        expect(completed.match(/Oracle has spoken/g) ?? []).toHaveLength(1)
        expect(completed.split(nestedTool)).toHaveLength(2)
        expect(completed).toContain("Oracle result")
        expect(completed).toContain("ORACLE_STYLE_RESULT")
        expect(completed).toContain("NESTED_TOOL_CONTENT")
        expect(completed).not.toContain("## Oracle result")
        expect(completed).not.toContain("The subagent finished without a final message.")
        expect(completed).not.toContain("Collected subagents")
        expect(completed).not.toContain("Waiting for subagents")
        expect(completed).not.toContain("1 line")
        expect(completed).not.toMatch(/\d+(?:ms|\.\d+s)\b/)
        expect(completed).not.toContain(" ts ")
        expect(spanHasColor(app, "\u251c ", "128,128,128,255"), "nested tool branch span").toBe(true)
        const connectors = app
          .spans()
          .lines.flatMap((line) => line.spans)
          .filter((span) => /^ +[│├└]/u.test(span.text))
        expect(connectors.length).toBeGreaterThan(0)
        expect([...new Set(connectors.map((span) => span.fg.toInts().join(",")))]).toEqual(["128,128,128,255"])
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "keeps a completed child explicitly open across group settlement and later app updates",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          height: 48,
          lanes: [
            {
              steps: [
                model.turn([
                  model.spawn(
                    [
                      { profile: "Oracle", name: "Quick review", prompt: "Finish the quick review." },
                      { profile: "Task", name: "Slow review", prompt: "Finish the slow review." },
                    ],
                    "review-group",
                  ),
                ]),
                model.text("ROOT_REVIEWS_DONE"),
                model.text("ROOT_FOLLOWUP_DONE"),
                model.text("ROOT_EXTRA_ACK"),
              ],
            },
            { profile: "Oracle", steps: [model.text("PERSISTENT_CHILD_ANSWER")] },
            { profile: "Task", steps: [model.text("SLOW_CHILD_ANSWER", 5_000)] },
          ],
        })
        yield* app.submit("Delegate both reviews.")
        yield* app.waitFrame("Quick review finished", 30_000)
        expect(app.frame()).not.toContain("PERSISTENT_CHILD_ANSWER")
        yield* app.clickText("Quick review finished")
        yield* app.waitFrame("PERSISTENT_CHILD_ANSWER")
        yield* app.waitFrame("ROOT_REVIEWS_DONE", 30_000)
        const settled = yield* app.settled
        expect(settled).toContain("PERSISTENT_CHILD_ANSWER")
        expect(settled).toContain("Slow review finished")
        // Composer and animation updates must not undo the explicit disclosure either.
        yield* Effect.tryPromise(() => app.type("Keep this draft"))
        expect(yield* app.nextFrame).toContain("PERSISTENT_CHILD_ANSWER")
        yield* app.clickText("Quick review finished")
        expect(yield* app.waitGone("PERSISTENT_CHILD_ANSWER")).not.toContain("PERSISTENT_CHILD_ANSWER")
        yield* app.quit
      }),
    ),
  60_000,
)
