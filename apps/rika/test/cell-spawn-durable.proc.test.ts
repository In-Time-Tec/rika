import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

/**
 * The discriminator between "the spawn cell never ran" and "the child ran but its card was
 * misplaced". Both present identically in the rendered frame, so this reads the DURABLE transcript
 * and reports the cell's own outcome rather than anything the projection did with it.
 *
 * It asserts what ADMISSION guarantees and no more. A spawn returns a receipt without waiting, so a
 * child that has not answered yet is the contract working; a lane that needs a settled child waits
 * for one explicitly.
 *
 * This spawns a real child through a real kernel worker, so it is a process test.
 */
test(
  "a cell that spawns a child admits it into the durable transcript under that cell",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Oracle", prompt: "PROBE_CHILD_PROMPT" }], "probe-spawn")]),
                model.text("PROBE_ROOT_COMPLETE"),
                model.text("PROBE_CHILD_SETTLEMENT_ACKNOWLEDGED"),
                model.text("PROBE_CHILD_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            { profile: "Oracle", steps: [model.text("PROBE_CHILD_RESULT")] },
          ],
        })

        yield* Effect.promise(() => app.type("Delegate one probe child."))
        app.pressEnter()
        yield* app.waitFrame("PROBE_ROOT_COMPLETE", 20_000)
        yield* app.settled

        const durable = yield* app.transcript(Turn.TurnId.make("tui-turn-0"))
        const units = durable?.units ?? []
        const cells = units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "Cell" ? [unit.content.block] : [],
        )
        const cards = units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? [unit.content.block] : [],
        )

        // The spawn cell must SUCCEED. A cell that failed reports its error here, which is the
        // difference between a broken binding and a misplaced card.
        expect(cells.map(({ status }) => status)).toEqual(["complete"])
        expect(cells.at(0)?.error).toBeUndefined()

        // The child must exist under the profile it was admitted for. Its STATUS is deliberately not
        // asserted: admission is non-blocking, so a child that has not settled yet is the contract
        // working rather than a defect, and the lanes that need a settled child wait for one.
        expect(cards.map(({ name }) => name)).toEqual(["Oracle"])
        expect(cards.map(({ status }) => status)).not.toContain("failed")

        // The card belongs to the cell that spawned it, which is the correlation the invocation id carries.
        const cardUnit = units.find(
          (unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard",
        )
        expect(cardUnit?.parentId).toBe(cells.at(0)?.id)
        yield* app.quit
      }),
    ),
  60_000,
)
