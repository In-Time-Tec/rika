import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000

test(
  "queues excess group members and promotes them without another parent turn",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          subagents: { maxDepth: 1, maxSubagents: 4 },
          height: 40,
          lanes: [
            {
              steps: [
                model.turn([
                  model.spawn(
                    [
                      { profile: "Task", prompt: "FIRST_CHILD", name: "First" },
                      { profile: "Oracle", prompt: "SECOND_CHILD", name: "Second" },
                      { profile: "Review", prompt: "THIRD_CHILD", name: "Third" },
                      { profile: "Surgeon", prompt: "FOURTH_CHILD", name: "Fourth" },
                      { profile: "Librarian", prompt: "FIFTH_CHILD", name: "Fifth" },
                    ],
                    "five-child-group",
                  ),
                ]),
                model.text("ROOT_RESUMED_AFTER_ALL_FIVE"),
              ],
            },
            { profile: "Task", steps: [model.text("FIRST_DONE", 1_500)] },
            { profile: "Oracle", steps: [model.text("SECOND_DONE", 1_500)] },
            { profile: "Review", steps: [model.text("THIRD_DONE", 1_500)] },
            { profile: "Surgeon", steps: [model.text("FOURTH_DONE", 1_500)] },
            { profile: "Librarian", steps: [model.text("FIFTH_DONE", 1_500)] },
          ],
        })

        yield* Effect.tryPromise(() => app.type("Run five children with four active slots."))
        app.pressEnter()

        const turnId = Turn.TurnId.make("tui-turn-0")
        const queued = yield* app.waitTranscript(turnId, (projection) => {
          const cards = projection.units.flatMap((unit) =>
            unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? [unit.content.block] : [],
          )
          return (
            cards.length === 5 &&
            cards.filter(({ status }) => status === "running").length === 4 &&
            cards.some(({ name, status }) => name === "Fifth" && status === "queued")
          )
        })
        const queuedCards = queued.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? [unit.content.block] : [],
        )
        expect(queuedCards.filter(({ status }) => status === "running")).toHaveLength(4)
        expect(yield* app.waitFrame("Fifth queued")).toContain("◷ Fifth queued")

        yield* app.waitTranscript(turnId, (projection) =>
          projection.units.some(
            (unit) =>
              unit.content._tag === "Block" &&
              unit.content.block._tag === "SubagentCard" &&
              unit.content.block.name === "Fifth" &&
              unit.content.block.status === "running",
          ),
        )
        expect(yield* app.modelRequestCount).toBe(1)

        yield* app.waitFrame("ROOT_RESUMED_AFTER_ALL_FIVE", 20_000)
        yield* app.settled
        const completed = yield* app.waitTranscript(turnId, (projection) => {
          const cards = projection.units.flatMap((unit) =>
            unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? [unit.content.block] : [],
          )
          return cards.length === 5 && cards.every(({ status }) => status === "complete")
        })
        expect(
          completed.units.flatMap((unit) =>
            unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? [unit.content.block] : [],
          ),
        ).toHaveLength(5)
        expect(yield* app.modelRequestCount).toBe(2)

        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
