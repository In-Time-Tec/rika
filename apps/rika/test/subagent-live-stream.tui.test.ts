import * as Turn from "@rika/product/turn-record"
import { Deferred, Effect, Schema } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const waitForCompletedProjection = Effect.fn("TuiApp.waitForCompletedProjection")(function* (
  app: TuiApp.TuiApp,
  turnId: Turn.TurnId,
) {
  const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  for (;;) {
    const projection = yield* app.transcript(turnId)
    if (
      projection !== undefined &&
      projection.executionCheckpoints.length > 0 &&
      projection.executionCheckpoints.every((checkpoint) => checkpoint.status === "completed")
    )
      return projection
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    if (now - started >= 5_000) return yield* Effect.die(`turn ${turnId} was not durably completed`)
    yield* Effect.sleep("20 millis")
  }
})

const waitForDurableChildOutput = Effect.fn("TuiApp.waitForDurableChildOutput")(function* (
  app: TuiApp.TuiApp,
  turnId: Turn.TurnId,
) {
  const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
  for (;;) {
    const projection = yield* app.transcript(turnId)
    const encodedUnits =
      projection === undefined ? undefined : yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(projection.units)
    if (
      projection !== undefined &&
      projection.executionCheckpoints.length === 2 &&
      projection.executionCheckpoints.every((checkpoint) => checkpoint.status === "completed") &&
      encodedUnits !== undefined &&
      encodedUnits.includes("CHILD_STREAMED_BEFORE_ROOT")
    )
      return projection
    const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
    if (now - started >= 5_000) return yield* Effect.die("child output was not durably persisted")
    yield* Effect.sleep("20 millis")
  }
})

test(
  "streams child progress before the root execution completes",
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
                model.text("ROOT_FINISHED_AFTER_CHILD_STREAM", 2_000),
              ],
            },
            {
              when: (prompt) => !prompt.includes("Verify live child streaming."),
              script: [
                model.toolCall("read", { path: "live-child.txt" }, "live-read"),
                model.turn([
                  model.part("CHILD_STREAMED_BEFORE_ROOT"),
                  model.toolCall("bash", { command: "sleep 3" }, "live-child-hold"),
                ]),
                model.text("CHILD_FINISHED_AFTER_HOLD"),
              ],
            },
          ],
        })

        yield* Effect.promise(() => app.type("Verify live child streaming."))
        app.pressEnter()
        yield* app.waitFrame("Subagent working")
        app.pressKey("\t")
        app.pressEnter()
        const firstVisible = yield* app.waitFrame("CHILD_STREAMED_BEFORE_ROOT", 3_000)
        expect(firstVisible).not.toContain("ROOT_FINISHED_AFTER_CHILD_STREAM")

        yield* Effect.sleep("750 millis")
        const live = yield* app.waitFrameMatch(
          (frame) => frame.includes("CHILD_STREAMED_BEFORE_ROOT") && frame.includes("Subagent working"),
          2_000,
        )
        expect(live).not.toContain("CHILD_FINISHED_AFTER_HOLD")
        expect(live).not.toContain("ROOT_FINISHED_AFTER_CHILD_STREAM")
        expect(live).not.toContain("Execution failed")

        yield* app.waitFrame("CHILD_FINISHED_AFTER_HOLD")
        yield* app.waitFrame("ROOT_FINISHED_AFTER_CHILD_STREAM")

        const turnId = Turn.TurnId.make("tui-turn-0")
        const durable = yield* waitForDurableChildOutput(app, turnId)
        expect(durable.executionCheckpoints.some((checkpoint) => checkpoint.attachment !== undefined)).toBe(true)

        yield* Effect.sleep("300 millis")
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
  240_000,
)

test(
  "retains prior turns across an active-only resync at realistic tool and child volume",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const toolCalls = Array.from({ length: 65 }, (_, index) =>
          model.toolCall("read", { path: "volume.txt" }, `volume-read-${index}`),
        )
        let reloadActiveTurnId: string | undefined
        let reloadEntryTurnIds: ReadonlyArray<string> = []
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          height: 600,
          workspaceFiles: { "volume.txt": "realistic tool output\n".repeat(30) },
          mapInteractiveEvent: (event) => {
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
                model.turn(toolCalls),
                model.text("PRIOR_TURN_HISTORY_MARKER"),
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

        yield* Effect.promise(() => app.type("First turn"))
        app.pressEnter()
        yield* app.waitFrame("PRIOR_TURN_HISTORY_MARKER")
        yield* waitForCompletedProjection(app, Turn.TurnId.make("tui-turn-0"))
        yield* app.settled

        yield* Effect.promise(() => app.type("Run realistic volume"))
        app.pressEnter()
        yield* app.waitFrame("Run realistic volume")
        yield* app.waitFrame("Waiting")
        yield* app.reload
        expect(reloadActiveTurnId).toBe("tui-turn-1")
        expect(new Set(reloadEntryTurnIds)).toEqual(new Set(["tui-turn-1"]))
        yield* Effect.sleep("200 millis")
        const reloaded = app.frame()
        const retainedAfterReload = reloaded.includes("PRIOR_TURN_HISTORY_MARKER")
        expect(reloaded).not.toContain("Execution failed")
        for (let page = 0; page < 3; page += 1) app.pressKey("\u001b[5~")
        const pagedHistory = yield* Effect.exit(app.waitFrame("PRIOR_TURN_HISTORY_MARKER", 2_000))
        for (let page = 0; page < 3; page += 1) app.pressKey("\u001b[6~")

        yield* app.waitFrame("REALISTIC_VOLUME_ROOT_FINISHED", 20_000)
        const final = yield* app.settled
        expect(final).not.toContain("Execution failed")
        yield* app.quit
        expect(retainedAfterReload).toBe(true)
        expect(pagedHistory._tag).toBe("Success")
      }),
    ),
  240_000,
)

test(
  "settles activity before a held child projection follower drains",
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
        yield* app.waitFrame("Subagent working")
        app.pressKey("\t")
        app.pressEnter()
        yield* app.waitFrame("ROOT_SETTLED_BEFORE_CHILD_PROJECTION")
        const settled = yield* app.settled
        for (const marker of ["Waiting", "Streaming", "Thinking", "Sending", "Running 1 subagent"])
          expect(settled).not.toContain(marker)

        const rootId = Turn.TurnId.make("tui-turn-0")
        const open = yield* app.transcript(rootId)
        expect(open?.executionCheckpoints.some((checkpoint) => checkpoint.executionKey !== String(rootId))).toBe(true)
        expect(open?.executionCheckpoints.some((checkpoint) => checkpoint.status !== "completed")).toBe(true)

        yield* Deferred.succeed(hold, undefined)
        const durable = yield* waitForDurableChildOutput(app, rootId)
        expect(durable.executionCheckpoints.every((checkpoint) => checkpoint.status === "completed")).toBe(true)
        const final = yield* app.settled
        for (const marker of ["Waiting", "Streaming", "Thinking", "Sending", "Running 1 subagent"])
          expect(final).not.toContain(marker)
        yield* app.quit
      }),
    ),
  240_000,
)
