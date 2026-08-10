import * as Turn from "@rika/product/turn-record"
import { Deferred, Effect } from "effect"
import { performance } from "node:perf_hooks"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 30_000
const currentWallTime = () => performance.now()

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

test(
  "retains prior turns across an active-only resync at realistic tool and child volume",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const marker = "PRIOR_TURN_HISTORY_MARKER"
        const threadId = "tui-pageup-thread"
        const toolCalls = Array.from({ length: 24 }, (_, index) =>
          model.binding(
            { module: "workspace", operation: "read", input: { path: "volume.txt" } },
            `volume-read-${index}`,
          ),
        )
        let reloadTurnIds: ReadonlyArray<string> = []
        const olderPageCursors: Array<string> = []
        let reachedOldest = false
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          height: 600,
          historicalTranscriptFixture: { threadId, entryCount: 412, marker },
          workspaceFiles: { "volume.txt": "realistic tool output\n".repeat(30) },
          mapInteractiveEvent: (event) => {
            if (event._tag === "ThreadViewSnapshot") {
              reloadTurnIds = event.snapshot.turns.map((entry) => String(entry.turn.id))
              const oldest = event.snapshot.source.oldestCursor
              const cursor =
                oldest === undefined ? undefined : `${oldest.createdAt}:${oldest.turnId}:${oldest.orderKey}`
              if (cursor !== undefined && !olderPageCursors.includes(cursor)) olderPageCursors.push(cursor)
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
        yield* Effect.promise(() => app.type("Run realistic volume"))
        app.pressEnter()
        yield* app.waitModelRequests(1)
        yield* app.reload
        const reloaded = app.frame()

        // The full timeline arrives in the initial snapshot: hasOlder is false immediately and no
        // page fetches exist to walk. PageUp travels the in-memory transcript to the seeded marker.
        expect(reachedOldest, "the full thread loads with hasOlder false").toBe(true)
        expect(olderPageCursors.length, "one snapshot per load, no page fetches").toBe(2)
        const pagingDeadline = currentWallTime() + 20_000
        let paged = app.frame()
        let previous = ""
        while (!paged.includes(marker) && paged !== previous && currentWallTime() < pagingDeadline) {
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
        yield* app.waitTranscript(Turn.TurnId.make("tui-turn-0"), (liveProjection) =>
          liveProjection.units.some((unit) => JSON.stringify(unit.content).includes("REALISTIC_VOLUME_ROOT_FINISHED")),
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
