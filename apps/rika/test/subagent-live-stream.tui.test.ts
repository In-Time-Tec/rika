import * as Turn from "@rika/product/turn-record"
import { Deferred, Effect } from "effect"
import { performance } from "node:perf_hooks"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 30_000
const currentWallTime = () => performance.now()

test(
  "projects live semantic subagent cards while parallel child work runs",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          workspaceFiles: { "live-child.txt": "LIVE_CHILD_FILE" },
          lanes: [
            {
              steps: [
                model.turn([
                  model.startChildGroup(
                    [
                      { key: "reader", selection: "Oracle", prompt: "READER_CHILD_PROMPT" },
                      { key: "worker", selection: "Task", prompt: "WORKER_CHILD_PROMPT" },
                    ],
                    { id: "live-group" },
                  ),
                ]),
                model.turn([model.awaitChildGroup("pending", "live-join")]),
                model.text("ROOT_FINISHED_AFTER_CHILD_STREAM"),
              ],
            },
            {
              profile: "Oracle",
              steps: [
                model.turn([model.tool("read", { path: "live-child.txt" }, "live-read")]),
                model.text("READER_CHILD_FINISHED", 400),
              ],
            },
            { profile: "Task", steps: [model.text("WORKER_CHILD_FINISHED", 800)] },
          ],
          height: 40,
        })

        yield* Effect.promise(() => app.type("Verify live child streaming."))
        app.pressEnter()

        const live = yield* app.waitFrameMatch(
          (frame) => frame.includes("Oracle exploring") && frame.includes("Subagent working"),
        )
        expect(live).toContain("Running 2 subagents")
        expect(live).not.toContain("Execution failed")

        const projected = yield* app.waitFrame("ROOT_FINISHED_AFTER_CHILD_STREAM")
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
        expect(cards.map(({ name }) => name)).toEqual(["Oracle", "Task"])
        expect(cards.map(({ prompt }) => prompt)).toEqual(["READER_CHILD_PROMPT", "WORKER_CHILD_PROMPT"])
        expect(cards.every(({ status }) => status === "complete")).toBe(true)
        expect(new Set(cards.map(({ id }) => id)).size).toBe(2)

        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

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
                model.turn([
                  model.startChildGroup(
                    [
                      { key: "first", selection: "Oracle", prompt: "FIRST_GROUP_PROMPT" },
                      { key: "second", selection: "Surgeon", prompt: "SECOND_GROUP_PROMPT" },
                    ],
                    { id: "dedupe-group" },
                  ),
                ]),
                model.turn([model.awaitChildGroup("pending", "dedupe-join")]),
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
        expect(cards.map(({ prompt }) => prompt)).toEqual(["FIRST_GROUP_PROMPT", "SECOND_GROUP_PROMPT"])
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "replays a restarted turn from its persisted checkpoint instead of from genesis",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          workspaceFiles: { "restart.txt": "RESTART_FIXTURE" },
          script: [
            model.turn([model.tool("read", { path: "restart.txt" }, "restart-read")]),
            model.text("RESTART_TURN_COMPLETE"),
          ],
        })

        yield* Effect.promise(() => app.type("Persist a checkpoint."))
        app.pressEnter()
        yield* app.waitFrame("RESTART_TURN_COMPLETE")
        yield* app.settled

        const turnId = Turn.TurnId.make("tui-turn-0")
        const before = yield* app.transcript(turnId)
        expect(before?.projectorCheckpoint?.cursor).toBeDefined()
        const requestsBefore = yield* app.modelRequestCount

        yield* app.reload
        const after = yield* app.transcript(turnId)
        expect(after?.projectorCheckpoint?.cursor).toBe(before?.projectorCheckpoint?.cursor)
        expect(after?.revision).toBe(before?.revision)
        expect(yield* app.modelRequestCount).toBe(requestsBefore)
        const frame = yield* app.waitFrame("RESTART_TURN_COMPLETE")
        expect(frame.match(/RESTART_TURN_COMPLETE/g) ?? []).toHaveLength(1)
        expect(frame).not.toContain("Execution failed")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test(
  "stays responsive to input while a subagent turn is still streaming",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              steps: [
                model.turn([model.runChild("Task", "RESPONSIVE_CHILD_PROMPT", "responsive-child")]),
                model.text("RESPONSIVE_ROOT_COMPLETE"),
              ],
            },
            { profile: "Task", steps: [model.text("RESPONSIVE_CHILD_RESULT", 5_000)] },
          ],
        })

        yield* Effect.promise(() => app.type("Delegate slow work."))
        app.pressEnter()
        yield* app.waitFrame("Subagent working")

        yield* Effect.promise(() => app.type("TYPED_WHILE_STREAMING"))
        const responsive = yield* app.waitFrame("TYPED_WHILE_STREAMING")
        expect(responsive).toContain("Subagent working")
        expect(responsive).toContain("Running 1 subagent")

        const completed = yield* app.waitFrame("RESPONSIVE_ROOT_COMPLETE")
        expect(completed).toContain("TYPED_WHILE_STREAMING")
        expect(completed).not.toContain("Execution failed")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

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
                model.turn([model.runChild("Task", "HELD_CHILD_PROMPT", "held-child")]),
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
          model.tool("read", { path: "volume.txt" }, `volume-read-${index}`),
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
                    model.startChildGroup(
                      [
                        { key: "alpha", selection: "Oracle", prompt: "Volume child A" },
                        { key: "beta", selection: "Task", prompt: "Volume child B" },
                      ],
                      { id: "volume-group" },
                    ),
                  ],
                  { delayMillis: 300 },
                ),
                model.turn([model.awaitChildGroup("pending", "volume-join")]),
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

        const pagingDeadline = currentWallTime() + 20_000
        for (;;) {
          if (reachedOldest) break
          if (currentWallTime() >= pagingDeadline)
            return yield* Effect.die(`page-up never reached the oldest page: ${olderPageCursors.length} pages loaded`)
          const before = olderPageCursors.length
          yield* app.pressPageUp
          for (let attempt = 0; attempt < 25; attempt += 1) {
            if (olderPageCursors.length > before || reachedOldest) break
            yield* Effect.sleep("10 millis")
          }
        }
        const paged = yield* app.waitFrame(marker, 10_000)
        expect(paged, "page-up reaches the seeded historical window").toContain(marker)

        app.pressKey("\u001b[F")
        const final = yield* app.waitFrame("REALISTIC_VOLUME_ROOT_FINISHED", 20_000)
        yield* app.quit

        expect(reloadTurnIds).toContain("tui-turn-0")
        expect(reloaded).not.toContain(marker)
        expect(reloaded).not.toContain("Execution failed")
        expect(olderPageCursors.length, "page-up fetched repeated older pages").toBeGreaterThan(2)
        expect(reachedOldest, "hasOlder becomes false at the true beginning").toBe(true)
        expect(final).not.toContain("Execution failed")
      }),
    ),
  tuiTestTimeout,
)
