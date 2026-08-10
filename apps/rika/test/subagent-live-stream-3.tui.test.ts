import * as Turn from "@rika/product/turn-record"
import { Effect } from "effect"
import { expect, test } from "vitest"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 30_000
test(
  "replays a restarted turn from its persisted checkpoint instead of from genesis",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          inspectTranscript: true,
          workspaceFiles: { "restart.txt": "RESTART_FIXTURE" },
          script: [
            model.turn([
              model.binding({ module: "workspace", operation: "read", input: { path: "restart.txt" } }, "restart-read"),
            ]),
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
