import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 30_000

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
