import * as Turn from "@rika/product/turn-record"
import { Deferred, Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000
test(
  "drains a held submission before settling activity",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const admission = yield* Deferred.make<void>()
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          holdSubmissionAdmission: admission,
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Task", prompt: "HELD_CHILD_PROMPT" }], "held-child")]),
                model.text("ROOT_SETTLED_AFTER_HOLD"),
                model.text("HELD_CHILD_SETTLEMENT_ACKNOWLEDGED"),
                model.text("HELD_CHILD_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            { profile: "Task", steps: [model.text("CHILD_STREAMED_AFTER_HOLD")] },
          ],
        })

        yield* Effect.promise(() => app.type("HELD_ROOT_PROMPT"))
        app.pressEnter()
        const held = yield* app.nextFrame
        expect(held).toContain("HELD_ROOT_PROMPT")
        expect(held).toContain("Sending")
        expect(held).not.toContain("HELD_CHILD_PROMPT")

        yield* Deferred.succeed(admission, undefined)
        yield* app.waitFrame("ROOT_SETTLED_AFTER_HOLD")
        const final = yield* app.settled
        for (const marker of ["Waiting", "Streaming", "Thinking", "Sending", "Running 1 subagent"])
          expect(final).not.toContain(marker)

        const durable = yield* app.waitTranscript(Turn.TurnId.make("tui-turn-0"), (projection) =>
          projection.units.some(
            (unit) =>
              unit.content._tag === "Block" &&
              unit.content.block._tag === "SubagentCard" &&
              unit.content.block.status === "complete",
          ),
        )
        const cards = durable.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? [unit.content.block] : [],
        )
        expect(cards.map(({ status }) => status)).toEqual(["complete"])
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
