import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import type { Prompt } from "effect/unstable/ai"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const promptText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) =>
      message.role === "user" || message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
        : [],
    )
    .join("\n")

test(
  "a slow child settles durably after its parent turn ends without inspect polling",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const largeResult = `CHILD_RESULT_START:${"x".repeat(20_000)}`
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Oracle", prompt: "SETTLEMENT_CHILD" }], "spawn-without-wait")]),
                model.text("FIRST_PARENT_TURN_ENDED"),
                model.text("SECOND_PARENT_TURN_RECEIVED_SETTLEMENT"),
              ],
            },
            { profile: "Oracle", steps: [model.text(largeResult, 750)] },
          ],
        })

        yield* Effect.promise(() => app.type("Start the slow child and end this turn."))
        app.pressEnter()
        yield* app.waitFrame("FIRST_PARENT_TURN_ENDED", 20_000)

        const first = yield* app.waitTranscript(Turn.TurnId.make("tui-turn-0"), (turn) =>
          turn.units.some(
            (unit) =>
              unit.content._tag === "Entry" &&
              unit.content.role === "assistant" &&
              unit.content.text.includes("FIRST_PARENT_TURN_ENDED"),
          ),
        )
        const sources = first.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "Cell" ? [unit.content.block.source.text] : [],
        )
        expect(sources.join("\n")).toContain("rika.agents.spawn")
        expect(sources.join("\n")).not.toContain("inspectAll")

        yield* Effect.sleep("1 second")
        yield* Effect.promise(() => app.type("Continue after the child settlement."))
        app.pressEnter()
        yield* app.waitFrame("SECOND_PARENT_TURN_RECEIVED_SETTLEMENT", 20_000)
        yield* app.waitModelRequests(3)

        const prompts = yield* app.modelPrompts
        const secondTurnPrompt = promptText(prompts.at(-1)!)
        expect(secondTurnPrompt).toContain("settled with status succeeded")
        expect(secondTurnPrompt).toContain("20019 UTF-8 bytes exceeds the 16384-byte notification limit")
        expect(secondTurnPrompt).not.toContain("x".repeat(1_000))
        yield* app.quit
      }),
    ),
  60_000,
)
