import * as Turn from "@rika/product/turn-record"
import { Effect, Schema } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

/**
 * Does `inspectAll` with a `waitMillis` return as soon as its child settles, or does it always burn
 * the whole ceiling?
 *
 * The answer separates two very different failures. A wait that returns quickly with a terminal
 * status means the feature works and a lane that times out is only a frame-ceiling problem. A wait
 * that always spends its ceiling means the port never reports a settled child as terminal, which
 * would be a defect in the wait itself. The cell measures its own elapsed time, so the reading comes
 * from inside the executing cell rather than from the harness observing it.
 *
 * This boots a real kernel worker and a real child Run, so it is a process test.
 */
const waitCeilingMillis = 20_000

/** What the cell reports about its own wait: how long it took, and what it saw. */
const Measurement = Schema.Struct({ elapsed: Schema.Finite, statuses: Schema.Array(Schema.String) })
const decodeMeasurement = Schema.decodeUnknownEffect(Schema.fromJsonString(Measurement))

test(
  "a cell waiting on a child returns when the child settles rather than spending its ceiling",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          lanes: [
            {
              steps: [
                model.turn([
                  model.cell(
                    [
                      `const started = Date.now()`,
                      `const admitted = await rika.agents.spawn({ profile: "Oracle", prompt: "WAIT_PROBE_CHILD" })`,
                      `const seen = await rika.agents.inspectAll({ childRunIds: [admitted.childRunId], waitMillis: ${waitCeilingMillis} })`,
                      `JSON.stringify({ elapsed: Date.now() - started, statuses: seen.map((child) => child.status) })`,
                    ].join("\n"),
                    "wait-probe",
                  ),
                ]),
                model.text("WAIT_PROBE_ROOT_COMPLETE"),
              ],
            },
            { profile: "Oracle", steps: [model.text("WAIT_PROBE_CHILD_RESULT")] },
          ],
        })

        yield* Effect.promise(() => app.type("Delegate and wait for one child."))
        app.pressEnter()
        yield* app.waitFrame("WAIT_PROBE_ROOT_COMPLETE", 60_000)
        yield* app.settled

        const durable = yield* app.transcript(Turn.TurnId.make("tui-turn-0"))
        const cells = (durable?.units ?? []).flatMap((unit) =>
          unit.content._tag === "Block" && unit.content.block._tag === "Cell" ? [unit.content.block] : [],
        )
        const waiting = cells.at(0)
        expect(waiting?.status, `cell error: ${waiting?.error?.message ?? "none"}`).toBe("complete")
        const measured = yield* decodeMeasurement(waiting?.result).pipe(Effect.orDie)
        // The child answers immediately, so a wait that reports it as terminal proves the poll sees
        // settlement; a wait that spent the ceiling would report it still running.
        expect(measured.statuses).toEqual(["succeeded"])
        expect(measured.elapsed).toBeLessThan(waitCeilingMillis)
        yield* app.quit
      }),
    ),
  120_000,
)
