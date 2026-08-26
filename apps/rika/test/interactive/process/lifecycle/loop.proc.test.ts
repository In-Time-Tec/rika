import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "../../../support/tui-app.harness"
import { model } from "../../../support/tui-model.fixture"

test(
  "a blocking child remains durable and nested under its parent Run",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              steps: [
                model.turn([
                  model.spawn(
                    [{ profile: "Oracle", prompt: "PROBE_CHILD_PROMPT", name: "Probe project structure" }],
                    "probe-child",
                  ),
                ]),
                model.text("PROBE_ROOT_RESUMED"),
              ],
            },
            { profile: "Oracle", steps: [model.text("PROBE_CHILD_RESULT")] },
          ],
        })

        yield* Effect.tryPromise(() => app.type("Delegate one probe child."))
        app.pressEnter()
        yield* app.waitFrame("PROBE_ROOT_RESUMED", 20_000)
        yield* app.settled

        const durable = yield* app.transcript(Turn.TurnId.make("tui-turn-0"))
        const units = durable?.units ?? []
        const cards = units.flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? [unit.content.block] : [],
        )
        expect(cards.map(({ name }) => name)).toEqual(["Probe project structure"])
        expect(cards.map(({ status }) => status)).toEqual(["complete"])
        const cardUnit = units.find(
          (unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard",
        )
        expect(cardUnit?.parentId).toBeUndefined()
        const childResult = units.find(
          (unit) => unit.content._tag === "Entry" && unit.content.text.includes("PROBE_CHILD_RESULT"),
        )
        expect(childResult?.parentId).toBe(cards[0]?.id)
        yield* app.quit
      }),
    ),
  60_000,
)

test(
  "one blocking group creates exactly four distinct direct cards and resumes its parent",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const children = [
          { profile: "Oracle" as const, prompt: "GROUP_ORACLE", name: "Map architecture" },
          { profile: "Librarian" as const, prompt: "GROUP_LIBRARIAN", name: "Research references" },
          { profile: "Surgeon" as const, prompt: "GROUP_SURGEON", name: "Inspect defect" },
          { profile: "Task" as const, prompt: "GROUP_TASK", name: "Check implementation" },
        ]
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              steps: [model.turn([model.spawn(children, "four-child-group")]), model.text("FOUR_CHILD_PARENT_RESUMED")],
            },
            { profile: "Oracle", steps: [model.text("ORACLE_GROUP_RESULT")] },
            { profile: "Librarian", steps: [model.text("LIBRARIAN_GROUP_RESULT")] },
            { profile: "Surgeon", steps: [model.text("SURGEON_GROUP_RESULT")] },
            { profile: "Task", steps: [model.text("TASK_GROUP_RESULT")] },
          ],
        })

        yield* Effect.tryPromise(() => app.type("Run four independent investigations."))
        app.pressEnter()
        yield* app.waitFrame("FOUR_CHILD_PARENT_RESUMED", 30_000)
        yield* app.settled

        const durable = yield* app.transcript(Turn.TurnId.make("tui-turn-0"))
        const cardUnits = (durable?.units ?? []).filter(
          (unit) => unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard",
        )
        const cards = cardUnits.map((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? unit.content.block : undefined,
        )
        expect(cards.map((card) => card?.name)).toEqual(children.map(({ name }) => name))
        expect(new Set(cards.map((card) => card?.id)).size).toBe(4)
        expect(cards.map((card) => card?.status)).toEqual(["complete", "complete", "complete", "complete"])
        expect(cardUnits.every((unit) => unit.parentId === undefined)).toBe(true)
        yield* app.quit
      }),
    ),
  60_000,
)
