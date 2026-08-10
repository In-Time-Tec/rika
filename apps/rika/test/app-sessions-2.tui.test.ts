import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 30_000

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
