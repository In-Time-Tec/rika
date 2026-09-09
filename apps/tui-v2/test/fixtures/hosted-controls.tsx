import * as BunRuntime from "@effect/platform-bun/BunRuntime"
/* oxlint-disable typescript/no-unsafe-call -- OpenTUI's test renderer exposes untyped render handles in this fixture. */
/* oxlint-disable typescript/no-unsafe-member-access -- OpenTUI's test renderer exposes untyped render handles in this fixture. */
/* oxlint-disable typescript/no-unsafe-return -- the JSX render callback is validated by the process-level TUI test. */
import { testRender } from "@opentui/solid"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { App } from "../../src/app"
import type { Client, ClientState, ThreadView } from "../../src/client/model"

const thread: ThreadView = {
  id: "hosted-thread",
  title: "Hosted review",
  target: "runner",
  activity: "working",
  items: [{ id: "assistant", kind: "assistant", title: "Rika", text: "Hosted answer is streaming", status: "working" }],
  pending: [{ id: "pending", prompt: "Continue the hosted review" }],
  approval: null,
}

const state: ClientState = {
  scenario: "conversation",
  selectedThreadId: thread.id,
  threads: [thread],
  mode: "medium",
  connection: "reconnecting",
  notice: "Reconnecting to hosted Rika…",
}

const flow = Effect.scoped(
  Effect.gen(function* () {
    let cancels = 0
    let stops = 0
    let quits = 0
    const client: Client = {
      get state() {
        return state
      },
      loadScenario: () => {},
      selectThread: () => {},
      newThread: () => {},
      archiveThread: () => {},
      submit: () => {},
      cancel: () => {
        cancels += 1
      },
      stop: () => {
        stops += 1
      },
      followUp: () => {},
      approve: () => {},
      editPending: () => {},
      removePending: () => {},
      steerPending: () => {},
      interruptAndSend: () => {},
      setMode: () => {},
      dispose: Effect.void,
    }
    const screen = yield* Effect.acquireRelease(
      Effect.tryPromise(() =>
        testRender(
          () => <App client={client} animate={false} onQuit={() => { quits += 1 }} />,
          { width: 120, height: 32, exitOnCtrlC: false },
        ),
      ),
      (value) => Effect.sync(() => value.renderer.destroy()),
    )
    yield* Effect.tryPromise(() => screen.flush())
    const connectedFrame = screen.captureCharFrame()
    assert.match(connectedFrame, /Reconnecting to hosted Rika/)
    assert.match(connectedFrame, /Hosted answer is streaming/)
    screen.mockInput.pressKey("o", { ctrl: true })
    yield* Effect.tryPromise(() => screen.flush())
    screen.mockInput.pressKey("s")
    screen.mockInput.pressKey("t")
    screen.mockInput.pressKey("o")
    screen.mockInput.pressKey("p")
    yield* Effect.tryPromise(() => screen.flush())
    assert.match(screen.captureCharFrame(), /Stop current Session/)
    const stop = screen.renderer.root.findDescendantById("command-palette-entry-stop")
    assert.ok(stop !== undefined)
    yield* Effect.tryPromise(() => screen.mockMouse.click(stop.x + 2, stop.y))
    assert.equal(stops, 1)
    screen.mockInput.pressCtrlC()
    yield* Effect.tryPromise(() => screen.flush())
    assert.equal(cancels, 1)
    screen.mockInput.pressCtrlC()
    assert.equal(quits, 1)
  }),
)

BunRuntime.runMain(flow)
