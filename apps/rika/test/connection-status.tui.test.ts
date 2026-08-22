import { expect, test } from "vitest"
import { Effect } from "effect"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000

test(
  "shows connecting and reconnecting in the bottom-left status without closing the TUI",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          initialConnectionStatus: "connecting",
          script: [model.text("WORK_CONTINUED", 1_000)],
        })

        expect(yield* app.waitFrame("Connecting")).toContain("Welcome to Rika")
        yield* app.setConnectionStatus("connected")
        yield* app.waitGone("Connecting")

        yield* Effect.promise(() => app.type("Keep working during replacement"))
        app.pressEnter()
        yield* app.waitFrame("Waiting")
        yield* app.setConnectionStatus("reconnecting")
        const reconnecting = yield* app.waitFrame("Reconnecting")
        expect(reconnecting).toContain("Keep working during replacement")

        yield* app.setConnectionStatus("connected")
        yield* app.waitGone("Reconnecting")
        yield* app.waitFrame("WORK_CONTINUED")

        yield* app.setConnectionStatus("authenticating")
        yield* app.waitFrame("Connecting")

        const hidden = [
          "Owner:",
          "Placement:",
          "selected executor",
          "Workspace",
          "lease",
          "Retry",
          "Approval",
          "outcome unknown",
          "Thread terminal",
        ]
        for (const status of [
          "personal-owner",
          "local-placement",
          "executor-waiting",
          "workspace-setup",
          "workspace-resuming",
          "lease-active",
          "retrying",
          "approval-required",
          "unknown-operation",
          "terminal",
        ] as const) {
          yield* app.setConnectionStatus(status)
          const frame = yield* app.waitGone("Connecting")
          for (const label of hidden) expect(frame).not.toContain(label)
          yield* app.setConnectionStatus("connecting")
          yield* app.waitFrame("Connecting")
        }
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)
