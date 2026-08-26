import * as Turn from "@rika/product/turn-record"
import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "../../support/tui-app.harness"
import { model } from "../../support/tui-model.fixture"

const tuiTestTimeout = 60_000

test(
  "reloads a failed root with its completed subagent from durable state",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          /**
           * Child admission is non-blocking, so the root failure below does not prove that its child
           * settled. The durable projection predicate below waits for the exact child result and card.
           */
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Task", prompt: "Run top-level work." }], "top-agent")]),
                model.failure("ROOT_RELOAD_FAILED"),
              ],
            },
            { profile: "Task", steps: [model.text("TOP_LEVEL_RELOAD_COMPLETE")] },
          ],
        })

        yield* Effect.tryPromise(() => app.type("Delegate nested work, then fail."))
        app.pressEnter()
        const turnId = Turn.TurnId.make("tui-turn-0")
        // The root fails only after the child it waited for has answered.
        yield* app.waitFrame("Execution failed", 25_000)
        yield* app.waitTranscript(
          turnId,
          (projection) =>
            projection.units.some(
              (unit) => unit.content._tag === "Entry" && unit.content.text === "TOP_LEVEL_RELOAD_COMPLETE",
            ) &&
            projection.units.some(
              (unit) =>
                unit.content._tag === "Block" &&
                unit.content.block._tag === "SubagentCard" &&
                unit.content.block.status === "complete",
            ),
          25_000,
        )

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
