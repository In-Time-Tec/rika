import * as Turn from "@rika/product/turn-record"
import { Clock, Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "../../../support/tui-app.harness"
import { model } from "../../../support/tui-model.fixture"

const tuiTestTimeout = 90_000

test(
  "retains prior turns across an active-only resync at realistic tool and child volume",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const marker = "PRIOR_TURN_HISTORY_MARKER"
        const threadId = "tui-pageup-thread"
        /**
         * The point of this lane is a transcript larger than one screen, so paging is exercised
         * rather than described. The entry count carries that; the viewport height and tool count
         * only have to exceed a screen, and at their former sizes the lane needed more memory than
         * a small runner has.
         */
        const toolCalls = Array.from({ length: 16 }, (_, index) =>
          model.binding(
            { module: "workspace", operation: "read", input: { path: "volume.txt" } },
            `volume-read-${index}`,
          ),
        )
        let reloadTurnIds: ReadonlyArray<string> = []
        const fixturePageCursors: Array<string> = []
        let reachedOldest = false
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
              if (!event.snapshot.hasOlder) reachedOldest = true
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
        yield* app.reload
        const reloaded = app.frame()

        // The full timeline arrives in the initial snapshot: hasOlder is false immediately and no
        // page fetches exist to walk. PageUp travels the in-memory transcript to the seeded marker.
        expect(reachedOldest, "the full thread loads with hasOlder false").toBe(true)
        // The seeded history arrives complete in one snapshot: the fixture thread's window is
        // assembled newest-first with a single true-oldest cursor, so no page fetches are needed.
        expect(fixturePageCursors, "the fixture window has one true-oldest cursor").toHaveLength(1)
        const pagingDeadline = (yield* Clock.currentTimeMillis) + 20_000
        let paged = app.frame()
        let previous = ""
        while (!paged.includes(marker) && paged !== previous && (yield* Clock.currentTimeMillis) < pagingDeadline) {
          previous = paged
          yield* app.pressPageUp
          paged = app.frame()
        }
        const projection = yield* app.transcript(Turn.TurnId.make("tui-pageup-thread-history"))
        const projectedMarker = projection?.units.some((unit) => JSON.stringify(unit.content).includes(marker)) === true
        expect(projectedMarker || paged.includes(marker), "page-up reaches the seeded historical window").toBe(true)

        if (paged.includes(marker)) {
          app.pressKey("\u001b[F")
          yield* Effect.sleep("500 millis")
        }
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
