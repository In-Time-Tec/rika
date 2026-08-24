import { Effect } from "effect"
import type { Prompt } from "effect/unstable/ai"
import { expect, test } from "vitest"
import * as Turn from "@rika/product/turn-record"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const userTexts = (prompt: Prompt.Prompt): ReadonlyArray<string> =>
  prompt.content.flatMap((message) =>
    message.role === "user" ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )

test(
  "a settled child never reaches a later turn as a user message",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Oracle", prompt: "SETTLE_CHILD_PROMPT" }], "settle-child")]),
                model.text("PARENT_RESUMED_AFTER_SETTLEMENT"),
                model.text("SECOND_TURN_DONE"),
              ],
            },
            { profile: "Oracle", steps: [model.text("SETTLE_CHILD_RESULT")] },
          ],
        })

        yield* Effect.tryPromise(() => app.type("Delegate one child and use its result."))
        app.pressEnter()
        yield* app.waitFrame("PARENT_RESUMED_AFTER_SETTLEMENT", 20_000)
        yield* app.settled

        yield* Effect.tryPromise(() => app.type("Now run an unrelated follow-up."))
        app.pressEnter()
        yield* app.waitFrame("SECOND_TURN_DONE", 20_000)
        yield* app.settled

        const delivered = (yield* app.modelPrompts).flatMap(userTexts)
        expect(delivered.some((text) => text.includes("settled with status"))).toBe(false)
        expect(delivered.some((text) => text.includes("Child run"))).toBe(false)

        const secondTurn = yield* app.transcript(Turn.TurnId.make("tui-turn-1"))
        const userEntries = (secondTurn?.units ?? []).flatMap((unit) =>
          unit.content._tag === "Entry" && unit.content.role === "user" ? [unit.content.text] : [],
        )
        expect(userEntries.some((text) => text.includes("settled with status"))).toBe(false)
        yield* app.quit
      }),
    ),
  90_000,
)

test(
  "a settled fan-out member never reaches a later turn as a user message",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const children = [
          { profile: "Oracle" as const, prompt: "FANOUT_ORACLE", name: "Map architecture" },
          { profile: "Surgeon" as const, prompt: "FANOUT_SURGEON", name: "Inspect defect" },
        ]
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              steps: [
                model.turn([model.spawn(children, "fanout-group")]),
                model.text("FANOUT_PARENT_RESUMED"),
                model.text("FANOUT_SECOND_TURN_DONE"),
              ],
            },
            { profile: "Oracle", steps: [model.text("FANOUT_ORACLE_RESULT")] },
            { profile: "Surgeon", steps: [model.text("FANOUT_SURGEON_RESULT")] },
          ],
        })

        yield* Effect.tryPromise(() => app.type("Run two independent investigations."))
        app.pressEnter()
        yield* app.waitFrame("FANOUT_PARENT_RESUMED", 30_000)
        yield* app.settled

        yield* Effect.tryPromise(() => app.type("Now run an unrelated follow-up."))
        app.pressEnter()
        yield* app.waitFrame("FANOUT_SECOND_TURN_DONE", 20_000)
        yield* app.settled

        const delivered = (yield* app.modelPrompts).flatMap(userTexts)
        expect(delivered.some((text) => text.includes("settled with status"))).toBe(false)
        yield* app.quit
      }),
    ),
  90_000,
)
