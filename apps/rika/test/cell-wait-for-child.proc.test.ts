import { Effect } from "effect"
import type { Prompt } from "effect/unstable/ai"
import { expect, test } from "vitest"
import * as Turn from "@rika/product/turn-record"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const promptText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => {
      if (message.role === "user" || message.role === "assistant")
        return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      if (message.role === "tool")
        return message.content.flatMap((part) => (part.type === "tool-result" ? [JSON.stringify(part.result)] : []))
      return []
    })
    .join("\n")

test(
  "a slow child resumes its parent Run without another user Turn",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const largeResult = `CHILD_RESULT_START:${"x".repeat(20_000)}:CHILD_RESULT_END`
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Oracle", prompt: "SETTLEMENT_CHILD" }], "blocking-child")]),
                model.text("PARENT_AUTOMATICALLY_RESUMED"),
              ],
            },
            { profile: "Oracle", steps: [model.text(largeResult, 750)] },
          ],
        })

        yield* Effect.promise(() => app.type("Start the slow child and use its result."))
        app.pressEnter()
        const completed = yield* app.waitFrame("PARENT_AUTOMATICALLY_RESUMED", 20_000)
        expect(completed).not.toContain("Execution failed")

        const prompts = yield* app.modelPrompts
        const resumedPrompt = prompts.map(promptText).find((value) => value.includes("CHILD_RESULT_START"))
        expect(resumedPrompt).toBeDefined()
        expect(resumedPrompt).toContain(largeResult)
        yield* app.settled
        const turnId = Turn.TurnId.make("tui-turn-0")
        const persisted = yield* app.transcript(turnId)
        expect(
          persisted?.units.find(
            (unit) => unit.content._tag === "Entry" && unit.content.text.startsWith("CHILD_RESULT_START"),
          )?.content,
        ).toEqual({ _tag: "Entry", role: "assistant", text: largeResult })
        yield* app.reload
        const restored = yield* app.transcript(turnId)
        expect(
          restored?.units.find(
            (unit) => unit.content._tag === "Entry" && unit.content.text.startsWith("CHILD_RESULT_START"),
          )?.content,
        ).toEqual({ _tag: "Entry", role: "assistant", text: largeResult })
        yield* app.quit
      }),
    ),
  60_000,
)
