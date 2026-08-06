import * as Turn from "@rika/product/turn-record"
import { Deferred, Effect, Schema } from "effect"
import { performance } from "node:perf_hooks"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 30_000
const currentWallTime = () => performance.now()

const waitForDurableChildOutput = Effect.fn("TuiApp.waitForDurableChildOutput")(function* (
  app: TuiApp.TuiApp,
  turnId: Turn.TurnId,
  marker = "CHILD_STREAMED_BEFORE_ROOT",
) {
  const started = currentWallTime()
  for (;;) {
    const projection = yield* app.transcript(turnId)
    const encodedUnits =
      projection === undefined ? undefined : yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(projection.units)
    if (
      projection !== undefined &&
      projection.executionCheckpoints.length === 2 &&
      projection.executionCheckpoints.every((checkpoint) => checkpoint.status === "completed") &&
      encodedUnits !== undefined &&
      encodedUnits.includes(marker)
    )
      return projection
    if (currentWallTime() - started >= 5_000) return yield* Effect.die("child output was not durably persisted")
    yield* Effect.sleep("20 millis")
  }
})

test(
  "projects child progress with the completed root execution",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          workspaceFiles: { "live-child.txt": "LIVE_CHILD_FILE" },
          lanes: [
            {
              script: [
                model.toolCall("task", { prompt: "Inspect the live child fixture." }, "live-child"),
                model.toolCall("await_subagents", {}, "live-join"),
                model.text("ROOT_FINISHED_AFTER_CHILD_STREAM"),
              ],
            },
            {
              when: (prompt) => !prompt.includes("Verify live child streaming."),
              script: [
                model.toolCall("read", { path: "live-child.txt" }, "live-read"),
                model.turn([
                  model.part("CHILD_STREAMED_BEFORE_ROOT"),
                  model.toolCall("bash", { command: "printf CHILD_TOOL_COMPLETE" }, "live-child-hold"),
                ]),
                model.text("CHILD_FINISHED_AFTER_HOLD"),
              ],
            },
          ],
        })

        yield* Effect.promise(() => app.type("Verify live child streaming."))
        app.pressEnter()
        yield* app.waitFrame("ROOT_FINISHED_AFTER_CHILD_STREAM")
        app.pressKey("\t")
        app.pressEnter()
        const projected = yield* app.waitFrame("CHILD_FINISHED_AFTER_HOLD", 3_000)
        expect(projected).toContain("CHILD_FINISHED_AFTER_HOLD")
        expect(projected).toContain("ROOT_FINISHED_AFTER_CHILD_STREAM")
        expect(projected).not.toContain("Execution failed")

        const turnId = Turn.TurnId.make("tui-turn-0")
        const durable = yield* waitForDurableChildOutput(app, turnId, "CHILD_FINISHED_AFTER_HOLD")
        expect(durable.executionCheckpoints.some((checkpoint) => checkpoint.attachment !== undefined)).toBe(true)

        const finalFrame = yield* app.waitFrame("ROOT_FINISHED_AFTER_CHILD_STREAM", 1_000)
        expect(finalFrame).not.toContain("Execution failed")

        let exited = false
        for (let attempt = 0; attempt < 3 && !exited; attempt += 1) {
          app.close()
          exited = yield* app.done.pipe(
            Effect.as(true),
            Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(false) }),
          )
        }
        expect(exited).toBe(true)
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
        const toolCalls = Array.from({ length: 65 }, (_, index) =>
          model.toolCall("read", { path: "volume.txt" }, `volume-read-${index}`),
        )
        let reloadActiveTurnId: string | undefined
        let reloadEntryTurnIds: ReadonlyArray<string> = []
        let prependedPages = 0
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          height: 600,
          historicalTranscriptFixture: { threadId, entryCount: 412, marker },
          workspaceFiles: { "volume.txt": "realistic tool output\n".repeat(30) },
          mapInteractiveEvent: (event) => {
            if (event._tag === "TranscriptPagePrepended") {
              prependedPages += 1
              return event
            }
            if (event._tag !== "SelectionLoaded" || event.selectionEpoch !== 100 || event.activeTurn === undefined)
              return event
            const entries = event.entries.filter((entry) => entry.turn.id === event.activeTurn?.id)
            reloadActiveTurnId = event.activeTurn.id
            reloadEntryTurnIds = entries.map((entry) => entry.turn.id)
            return { ...event, entries, hasOlder: true }
          },
          lanes: [
            {
              script: [
                model.turn(toolCalls, { delay: "1 second" }),
                model.turn(
                  [
                    model.toolCall("task", { prompt: "Volume child A" }, "volume-child-a"),
                    model.toolCall("task", { prompt: "Volume child B" }, "volume-child-b"),
                    model.toolCall("await_subagents", {}, "volume-join"),
                  ],
                  { delay: "1 second" },
                ),
                model.text("REALISTIC_VOLUME_ROOT_FINISHED", 500),
              ],
            },
            {
              when: (prompt) => !prompt.includes("Run realistic volume") && prompt.includes("Volume child A"),
              script: [model.text(`VOLUME_CHILD_A_STREAM ${"child A output ".repeat(300)}`, 300)],
            },
            {
              when: (prompt) => !prompt.includes("Run realistic volume") && prompt.includes("Volume child B"),
              script: [model.text(`VOLUME_CHILD_B_STREAM ${"child B output ".repeat(300)}`, 600)],
            },
          ],
        })

        expect(app.frame()).not.toContain(marker)
        yield* Effect.promise(() => app.type("Run realistic volume"))
        app.pressEnter()
        yield* app.waitModelRequests(1)
        yield* app.reload
        const reloaded = app.frame()

        for (let page = 0; page < 8; page += 1) {
          if (prependedPages > 0) break
          yield* app.pressPageUp
          for (let attempt = 0; attempt < 100; attempt += 1) {
            if (prependedPages > 0) break
            yield* Effect.sleep("20 millis")
          }
        }
        yield* Effect.sleep("200 millis")

        app.pressKey("\u001b[F")
        yield* app.waitFrame("REALISTIC_VOLUME_ROOT_FINISHED", 20_000)
        const final = yield* app.settled
        yield* app.quit

        expect(reloadActiveTurnId).toBe("tui-turn-0")
        expect(new Set(reloadEntryTurnIds)).toEqual(new Set(["tui-turn-0"]))
        expect(reloaded).not.toContain(marker)
        expect(reloaded).not.toContain("Execution failed")
        expect(prependedPages).toBeGreaterThan(0)
        expect(final).not.toContain("Execution failed")
      }),
    ),
  tuiTestTimeout,
)

test(
  "drains a held child projection before settling activity",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const hold = yield* Deferred.make<void>()
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          holdExecutionFollows: hold,
          lanes: [
            {
              script: [
                model.toolCall("task", { prompt: "Held child prompt" }, "held-child"),
                model.toolCall("await_subagents", {}, "held-child-join"),
                model.text("ROOT_SETTLED_BEFORE_CHILD_PROJECTION"),
              ],
            },
            {
              when: (prompt) => !prompt.includes("Hold child projection after root completion."),
              script: [model.text("CHILD_STREAMED_BEFORE_ROOT")],
            },
          ],
        })

        yield* Effect.promise(() => app.type("Hold child projection after root completion."))
        app.pressEnter()
        yield* app.waitModelRequests(4)
        yield* Deferred.succeed(hold, undefined)
        yield* app.waitFrame("ROOT_SETTLED_BEFORE_CHILD_PROJECTION")
        const rootId = Turn.TurnId.make("tui-turn-0")
        const durable = yield* waitForDurableChildOutput(app, rootId)
        expect(durable.executionCheckpoints.every((checkpoint) => checkpoint.status === "completed")).toBe(true)
        const final = yield* app.settled
        for (const marker of ["Waiting", "Streaming", "Thinking", "Sending", "Running 1 subagent"])
          expect(final).not.toContain(marker)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
