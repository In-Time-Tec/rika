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

        yield* Effect.tryPromise(() => app.type("Ask Oracle to inspect the fixture."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_STYLE_RESULT", 25_000)
        yield* app.settled
        // Two rows expand now: the cell that spawned the child, then the child's card. Selecting the
        // card is one Tab past the cell, and a card opens on Enter rather than on selection.
        yield* app.waitFrame("Oracle has spoken")
        app.pressKey("\t")
        app.pressKey("\t")
        app.pressEnter()
        const nestedCell = 'ts await rika.workspace.read({"path":"nested.txt"})'
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
        expect(completed).not.toContain("1 line")
        expect(completed).not.toContain(" · ")
        expect(spanHasColor(app, "ts", "128,128,128,255"), "nested cell language span").toBe(true)
        expect(spanHasColor(app, "\u251c ", "128,128,128,255"), "nested cell branch span").toBe(true)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
