import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000
test(
  "projects live semantic subagent cards while parallel child work runs",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              steps: [
                // Admission is non-blocking. The test observes both children live, then waits on the
                // durable cards rather than treating the root answer as proof that they settled.
                model.turn([
                  model.spawn(
                    [
                      { profile: "Oracle", prompt: "READER_CHILD_PROMPT" },
                      { profile: "Task", prompt: "WORKER_CHILD_PROMPT" },
                    ],
                    "live-group",
                  ),
                ]),
                model.text("ROOT_FINISHED_AFTER_CHILD_STREAM"),
                model.text("READER_CHILD_SETTLEMENT_ACKNOWLEDGED"),
                model.text("WORKER_CHILD_SETTLEMENT_ACKNOWLEDGED"),
                model.text("READER_CHILD_SETTLEMENT_RETRY_ACKNOWLEDGED"),
                model.text("WORKER_CHILD_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            // Each child answers in ONE turn. A child that called a tool first would need a second
            // turn, and its slot for that turn is the one the waiting root is holding — the same
            // circular wait a deeper chain hits. Both still run long enough to be seen live.
            { profile: "Oracle", steps: [model.text("READER_CHILD_FINISHED", 3_000)] },
            { profile: "Task", steps: [model.text("WORKER_CHILD_FINISHED", 4_000)] },
          ],
          height: 40,
        })

        yield* Effect.tryPromise(() => app.type("Verify live child streaming."))
        app.pressEnter()

        const live = yield* app.waitFrameMatch(
          (frame) =>
            frame.includes("Oracle exploring") &&
            frame.includes("Subagent working") &&
            frame.includes("Running 2 subagents"),
        )
        expect(live).toContain("Running 2 subagents")
        expect(live).not.toContain("Execution failed")

        // The root answer and child settlement race; neither is used as a proxy for the other.
        const projected = yield* app.waitFrame("ROOT_FINISHED_AFTER_CHILD_STREAM", 25_000)
        expect(projected).not.toContain("Execution failed")
        yield* app.settled

        const turnId = Turn.TurnId.make("tui-turn-0")
        const durable = yield* app.waitTranscript(turnId, (projection) =>
          projection.units.every(
            (unit) =>
              unit.content._tag !== "Block" ||
              unit.content.block._tag !== "SubagentCard" ||
              unit.content.block.status === "complete",
          ),
        )
        const cards = (durable?.units ?? []).flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "SubagentCard" ? [unit.content.block] : [],
        )
        // Concurrently admitted children race to land, so the set is what the product promises and
        // the sequence is not.
        // Concurrently admitted children land in whichever order their Runs reach the projector, so
        // the pairing of a card to its own prompt is the property, not the sequence.
        expect(cards.map(({ name, prompt }) => `${name}:${prompt}`).sort()).toEqual([
          "Oracle:READER_CHILD_PROMPT",
          "Task:WORKER_CHILD_PROMPT",
        ])
        expect(cards.every(({ status }) => status === "complete")).toBe(true)
        expect(new Set(cards.map(({ id }) => id)).size).toBe(2)

        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "streams a subagent answer before its model turn commits",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              steps: [
                model.turn([model.spawn([{ profile: "Task", prompt: "STREAM_CHILD_PROMPT" }], "stream-child")]),
                model.text("ROOT_AFTER_STREAM_CHILD"),
              ],
            },
            {
              profile: "Task",
              steps: [
                model.turn([model.part("CHILD_PREVIEW_FIRST"), model.part(" CHILD_PREVIEW_LAST")], {
                  streamPartDelayMillis: 1_000,
                }),
              ],
            },
          ],
          height: 36,
        })

        yield* Effect.tryPromise(() => app.type("Stream the child answer."))
        app.pressEnter()
        yield* app.waitFrame("Subagent working")
        app.pressKey("\t")
        app.pressEnter()

        const partial = yield* app.waitFrame("CHILD_PREVIEW_FIRST", 20_000)
        expect(partial).not.toContain("CHILD_PREVIEW_LAST")
        const durable = yield* app.transcript(Turn.TurnId.make("tui-turn-0"))
        expect(durable?.units.some((unit) => JSON.stringify(unit.content).includes("CHILD_PREVIEW_FIRST"))).toBe(false)

        const complete = yield* app.waitFrame("CHILD_PREVIEW_LAST", 20_000)
        expect(complete).toContain("CHILD_PREVIEW_FIRST")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
