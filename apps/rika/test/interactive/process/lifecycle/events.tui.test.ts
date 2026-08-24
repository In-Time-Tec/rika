import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "../../../support/tui-app.harness"
import { model } from "../../../support/tui-model.fixture"

const tuiTestTimeout = 60_000
const hasColor = (app: TuiApp.TuiApp, text: string, color: string): boolean =>
  app
    .spans()
    .lines.flatMap((line) => line.spans)
    .some((span) => span.text.includes(text) && span.fg.toInts().join(",") === color)

test(
  "shows transient status at bottom-left and only Orb placement on the composer",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          initialConnectionState: { connectivity: "connecting", target: "resolving", participants: 1 },
          script: [model.text("WORK_CONTINUED", 1_000)],
        })

        const connecting = yield* app.waitFrame("Connecting")
        expect(connecting).toContain("Welcome to Rika")
        expect(connecting).not.toContain("Resolving target")
        yield* app.setConnectionState({
          connectivity: "connected",
          target: "runner",
          activity: "executor-waiting",
          participants: 1,
        })
        const runnerIdle = yield* app.waitGone("Connecting")
        expect(runnerIdle).not.toContain("Runner")
        expect(runnerIdle).not.toContain("Waiting")

        yield* Effect.tryPromise(() => app.type("Keep working during replacement"))
        app.pressEnter()
        yield* app.waitFrame("Waiting")
        yield* app.setConnectionState({ connectivity: "reconnecting", target: "runner", participants: 1 })
        const reconnecting = yield* app.waitFrame("Reconnecting")
        expect(reconnecting).toContain("Keep working during replacement")
        expect(reconnecting).not.toContain("Runner")

        yield* app.setConnectionState({ connectivity: "connected", target: "runner", participants: 1 })
        yield* app.waitGone("Reconnecting")
        yield* app.waitFrame("WORK_CONTINUED")

        yield* app.setConnectionState({
          connectivity: "connected",
          target: "orb",
          activity: "workspace-setup",
          ownership: "organization",
          participants: 2,
        })
        const orb = yield* app.waitFrame("Setting up workspace")
        expect(orb).toContain("Orb")
        expect(hasColor(app, "Orb", "174,119,255,255")).toBe(true)
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
