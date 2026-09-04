import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "../../../support/tui-app.harness"
import { model } from "../../../support/tui-model.fixture"

const tuiTestTimeout = 90_000

test(
  "retains loaded history across resync and reaches it with Home at realistic tool and child volume",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const marker = "PRIOR_TURN_HISTORY_MARKER"
        const threadId = "tui-pageup-thread"
        /**
         * The point of this lane is a transcript larger than one screen, so scroll-back is exercised
         * rather than described. The entry count carries that; the viewport height and tool count
         * only have to exceed a screen, and at their former sizes the lane needed more memory than
         * a small runner has.
         */
        const toolCalls = Array.from({ length: 16 }, (_, index) =>
          model.tool("read", { path: "volume.txt" }, `volume-read-${index}`),
        )
        let reloadTurnIds: ReadonlyArray<string> = []
        const fixturePageCursors: Array<string> = []
        let hasOlderHistory = false
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          height: 300,
          historicalTranscriptFixture: { threadId, entryCount: 412, marker },
          workspaceFiles: { "volume.txt": "realistic tool output\n".repeat(30) },
          mapInteractiveEvent: (event) => {
            if (event._tag === "ThreadViewSnapshot") {
              reloadTurnIds = event.snapshot.turns.map((entry) => String(entry.turn.id))
              const oldest = event.snapshot.source.oldestCursor
              const cursor =
                oldest === undefined ? undefined : `${oldest.createdAt}:${oldest.turnId}:${oldest.orderKey}`
              if (
                cursor !== undefined &&
                String(event.snapshot.thread.id) === threadId &&
                !fixturePageCursors.includes(cursor)
              )
                fixturePageCursors.push(cursor)
              if (String(event.snapshot.thread.id) === threadId && event.snapshot.hasOlder) hasOlderHistory = true
            }
            return event
          },
          lanes: [
            {
              steps: [
                model.turn(toolCalls, { delayMillis: 300 }),
                model.turn(
                  [
                    model.spawn(
                      [
                        { profile: "Oracle", prompt: "Volume child A" },
                        { profile: "Task", prompt: "Volume child B" },
                      ],
                      "volume-group",
                    ),
                  ],
                  { delayMillis: 300 },
                ),
                model.text("REALISTIC_VOLUME_ROOT_FINISHED", 200),
                // Preserve enough script for independently arriving durable child settlements.
                model.text("VOLUME_CHILD_A_SETTLEMENT_ACKNOWLEDGED"),
                model.text("VOLUME_CHILD_B_SETTLEMENT_ACKNOWLEDGED"),
                model.text("VOLUME_CHILD_A_SETTLEMENT_RETRY_ACKNOWLEDGED"),
                model.text("VOLUME_CHILD_B_SETTLEMENT_RETRY_ACKNOWLEDGED"),
              ],
            },
            {
              profile: "Oracle",
              steps: [model.text(`VOLUME_CHILD_A_STREAM ${"child A output ".repeat(120)}`, 200)],
            },
            {
              profile: "Task",
              steps: [model.text(`VOLUME_CHILD_B_STREAM ${"child B output ".repeat(120)}`, 300)],
            },
          ],
        })

        expect(app.frame()).not.toContain(marker)
        yield* Effect.tryPromise(() => app.type("Run realistic volume"))
        app.pressEnter()
        yield* app.waitModelRequests(1)
        // Reload after the active Turn has durable units, not merely a model request.
        yield* app.waitTranscript(Turn.TurnId.make("tui-turn-0"), (projection) => projection.units.length > 0)
        yield* app.reload
        const reloaded = app.frame()

        expect(hasOlderHistory, "all 412 historical entries fit in the bounded timeline").toBe(false)
        expect(fixturePageCursors, "reload retains the oldest loaded cursor").toHaveLength(1)
        expect(reloaded).not.toContain(marker)
        app.pressKey("\u001b[H")
        expect(yield* app.waitFrame(marker)).toContain(marker)
        app.pressKey("\u001b[F")
        yield* app.waitTranscript(
          Turn.TurnId.make("tui-turn-0"),
          (liveProjection) =>
            liveProjection.units.some((unit) =>
              JSON.stringify(unit.content).includes("REALISTIC_VOLUME_ROOT_FINISHED"),
            ),
          30_000,
        )
        const final = app.frame()
        yield* app.quit

        expect(reloadTurnIds).toContain("tui-pageup-thread-history")
        expect(reloaded).not.toContain("Execution failed")
        expect(final).not.toContain("Execution failed")
        const liveProjection = yield* app.transcript(Turn.TurnId.make("tui-turn-0"))
        const liveFinished =
          liveProjection?.units.some((unit) =>
            JSON.stringify(unit.content).includes("REALISTIC_VOLUME_ROOT_FINISHED"),
          ) === true
        expect(liveFinished || final.includes("REALISTIC_VOLUME_ROOT_FINISHED")).toBe(true)
      }),
    ),
  tuiTestTimeout,
)
