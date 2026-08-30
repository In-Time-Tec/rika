import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "../support/tui-app.harness"
import { model } from "../support/tui-model.fixture"

const tuiTestTimeout = 90_000
test(
  "never duplicates a terminal subagent row across live projection and durable reload",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              steps: [
                // Admission is non-blocking, so ROOT_DEDUPE_COMPLETE can precede both terminal labels.
                // The frame predicate below waits for both exact child outcomes before checking dedupe.
                model.turn([
                  model.spawn(
                    [
                      { profile: "Oracle", prompt: "FIRST_GROUP_PROMPT" },
                      { profile: "Surgeon", prompt: "SECOND_GROUP_PROMPT" },
                    ],
                    "dedupe-group",
                  ),
                ]),
                model.text("ROOT_DEDUPE_COMPLETE"),
                model.text("FIRST_GROUP_SETTLEMENT_ACKNOWLEDGED"),
                model.text("SECOND_GROUP_SETTLEMENT_ACKNOWLEDGED"),
                model.text("FIRST_GROUP_SETTLEMENT_RETRY_ACKNOWLEDGED"),
                model.text("SECOND_GROUP_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            { profile: "Oracle", steps: [model.text("FIRST_GROUP_RESULT")] },
            { profile: "Surgeon", steps: [model.text("SECOND_GROUP_RESULT")] },
          ],
          height: 48,
        })

        yield* Effect.tryPromise(() => app.type("Run the deduplicated group."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_DEDUPE_COMPLETE")
        const settled = yield* app.waitFrameMatch(
          (frame) => frame.includes("Oracle has spoken") && frame.includes("Surgeon closed up"),
          40_000,
        )

        expect(settled.match(/Oracle has spoken/g) ?? []).toHaveLength(1)
        expect(settled.match(/Surgeon closed up/g) ?? []).toHaveLength(1)

        yield* app.reload
        const reloaded = yield* app.waitTranscript(Turn.TurnId.make("tui-turn-0"), (projection) =>
          projection.units.some((unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard"),
        )
        const cards = reloaded.units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? [unit.content.block] : [],
        )
        expect(cards).toHaveLength(2)
        expect(new Set(cards.map(({ id }) => id)).size).toBe(2)
        // Order is a race between two concurrently admitted Runs; each card keeping its OWN prompt
        // is the property the reload has to preserve.
        expect(cards.map(({ name, prompt }) => `${name}:${prompt}`).toSorted()).toEqual([
          "Oracle:FIRST_GROUP_PROMPT",
          "Surgeon:SECOND_GROUP_PROMPT",
        ])
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
