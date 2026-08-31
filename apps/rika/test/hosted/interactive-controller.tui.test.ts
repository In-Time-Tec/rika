import { Deferred, Effect } from "effect"
import { expect, test } from "vitest"
import * as Thread from "@rika/product/thread-record"
import * as TuiApp from "../support/tui-app.harness"
import { model } from "../support/tui-model.fixture"

const tuiTestTimeout = 90_000

test(
  "keeps the draft inert while the hosted connection is still connecting",
  () =>
    TuiApp.run(
      Effect.scoped(
        Effect.gen(function* () {
          const admit = yield* Deferred.make<void>()
          const app = yield* TuiApp.tuiApp({
            historicalTranscriptFixture: {
              threadId: "tui-thread-0",
              entryCount: 3,
              marker: "SEEDED_THREAD",
            },
            initialThreadId: "tui-thread-0",
            initialThreadSelected: true,
            initialConnectionState: { connectivity: "connecting", target: "resolving", participants: 1 },
            idStart: 10,
            holdSubmissionAdmission: admit,
            width: 80,
            height: 24,
            script: [model.text("STARTUP_REPLY")],
          })
          expect(yield* app.selectionAttempts).toBe(0)
          yield* app.waitFrame("SEEDED_THREAD")
          yield* Effect.tryPromise(() => app.type("Send while connecting"))
          app.pressEnter()
          const connecting = yield* app.nextFrame
          expect(connecting).toContain("Connecting")
          expect(connecting).toContain("│ Send while connecting")
          expect(connecting).not.toContain("Sending")
          expect((yield* app.queue(Thread.ThreadId.make("tui-thread-0"))).turns).toHaveLength(0)
          expect(yield* app.modelRequestCount).toBe(0)

          yield* app.setConnectionState({ connectivity: "connected", target: "runner", participants: 1 })
          const connected = yield* app.waitGone("Connecting")
          expect(connected).toContain("│ Send while connecting")
          expect(connected).not.toContain("STARTUP_REPLY")
          expect(yield* app.modelRequestCount).toBe(0)
          app.pressEnter()
          yield* Deferred.succeed(admit, undefined)
          const replied = yield* app.waitFrame("STARTUP_REPLY")
          expect(replied).toContain("Send while connecting")
          yield* app.quit
        }),
      ),
    ),
  tuiTestTimeout,
)

test(
  "waits for the existing connected state before sending an initial CLI prompt",
  () =>
    TuiApp.run(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* TuiApp.tuiApp({
            initialPrompt: ["Send", "after", "connection"],
            initialConnectionState: { connectivity: "connecting", target: "resolving", participants: 1 },
            script: [model.text("INITIAL_PROMPT_REPLY")],
          })
          yield* app.waitFrame("Connecting")
          expect(yield* app.submissionAttempts).toBe(0)
          expect(yield* app.modelRequestCount).toBe(0)

          yield* app.setConnectionState({ connectivity: "connected", target: "runner", participants: 1 })
          const replied = yield* app.waitFrame("INITIAL_PROMPT_REPLY")
          expect(replied).toContain("Send after connection")
          expect(yield* app.submissionAttempts).toBe(1)
          yield* app.quit
        }),
      ),
    ),
  tuiTestTimeout,
)
