import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 30_000
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
                // The root waits for both children, because the assertions below read their TERMINAL
                // labels: a root that only admits them reaches its own answer while they still run.
                model.turn([
                  model.spawnAndWait(
                    [
                      { profile: "Oracle", prompt: "FIRST_GROUP_PROMPT" },
                      { profile: "Surgeon", prompt: "SECOND_GROUP_PROMPT" },
                    ],
                    "dedupe-group",
                  ),
                ]),
                model.text("ROOT_DEDUPE_COMPLETE"),
              ],
            },
            { profile: "Oracle", steps: [model.text("FIRST_GROUP_RESULT")] },
            { profile: "Surgeon", steps: [model.text("SECOND_GROUP_RESULT")] },
          ],
          height: 48,
        })

        yield* Effect.promise(() => app.type("Run the deduplicated group."))
        app.pressEnter()
        const settled = yield* app.waitFrame("ROOT_DEDUPE_COMPLETE")
        yield* app.settled

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
        expect(cards.map(({ name, prompt }) => `${name}:${prompt}`).sort()).toEqual([
          "Oracle:FIRST_GROUP_PROMPT",
          "Surgeon:SECOND_GROUP_PROMPT",
        ])
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
