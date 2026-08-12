import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000

test(
  "delegates two levels deep, each level using a tool",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        // Delegation depth was thought to be bounded by scheduler slots. It was not: a child died on
        // its own session identity, and the arithmetic that seemed to explain it described the
        // symptom. This holds the real depth open so a regression reads as one.
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          workspaceFiles: { "deep.txt": "DEEP_BODY" },
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Task", prompt: "L1", name: "Parent survey" }], "l1")]),
                model.text("ROOT_DEEP_DONE"),
                model.text("ROOT_DEEP_SETTLEMENT_ACKNOWLEDGED"),
                model.text("ROOT_DEEP_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            {
              profile: "Task",
              steps: [
                model.turn([model.spawn([{ profile: "Oracle", prompt: "L2", name: "Nested survey" }], "l2")]),
                model.text("CHILD_DEEP_DONE"),
                model.text("CHILD_DEEP_SETTLEMENT_ACKNOWLEDGED"),
                model.text("CHILD_DEEP_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            {
              profile: "Oracle",
              steps: [
                model.turn([
                  model.binding({ module: "workspace", operation: "read", input: { path: "deep.txt" } }, "deep-read"),
                ]),
                model.text("GRANDCHILD_DONE", 2_000),
              ],
            },
          ],
          subagents: { maxDepth: 2, maxSubagents: 4 },
          height: 48,
        })
        yield* Effect.promise(() => app.type("Delegate deep work."))
        app.pressEnter()
        const direct = yield* app.waitFrame("Parent survey working", 30_000)
        expect(direct).toContain("Running 1 subagent")
        app.pressKey("\t")
        app.pressEnter()
        const recursive = yield* app.waitFrame("Nested survey finished", 30_000)
        expect(recursive).toContain("Parent survey")
        expect(recursive).toContain("Nested survey finished")
        expect(recursive).not.toContain("Running 2 subagents")
        yield* app.waitFrame("ROOT_DEEP_DONE", 30_000)
        const durable = yield* app.waitTranscript(
          Turn.TurnId.make("tui-turn-0"),
          (projection) =>
            projection.units.some((unit) => unit.content._tag === "Entry" && unit.content.text === "GRANDCHILD_DONE"),
          30_000,
        )
        const texts = (durable?.units ?? []).flatMap((unit) =>
          unit.content._tag === "Entry" ? [unit.content.text] : [],
        )
        expect(texts).toContain("GRANDCHILD_DONE")
        const completed = yield* app.waitFrame("Parent survey finished", 30_000)
        expect(completed).toContain("Nested survey finished")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
