import { expect, test } from "vitest"
import { createTestRenderer } from "@opentui/core/testing"
import { Surface } from "@rika/terminal/opentui-surface"
import * as InteractiveController from "../../../src/interactive/controller/service"
import { modelResponseId } from "@rika/product/execution-gateway"
import type * as InteractiveEvent from "@rika/product/interactive-event"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TerminalState from "@rika/terminal/terminal-state"
import { Effect } from "effect"
import * as TuiApp from "../../support/tui-app.harness"
import { model } from "../../support/tui-model.fixture"

const tuiTestTimeout = 90_000

test(
  "keeps accumulated usage visible after an attempt settles without usage",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const app = yield* TuiApp.tuiApp({
          lanes: [
            {
              steps: [
                model.turn([model.part("PRICED_TURN_COMPLETE")], { inputTokens: 1_200, outputTokens: 340 }),
                model.failure("UNPRICED_TURN_FAILED"),
              ],
            },
          ],
        })

        yield* Effect.tryPromise(() => app.type("Price this turn."))
        app.pressEnter()
        yield* app.waitFrame("PRICED_TURN_COMPLETE")
        // Live preview shows the answer text before the attempt commits usage; usage is only
        // available once the turn settles and the footer leaves the streaming state.
        yield* app.settled
        yield* app.waitFrame("ctx")
        yield* app.clickText("ctx")
        const priced = yield* app.waitFrame("Used")
        expect(priced).toContain("1.2K")
        expect(priced).not.toContain("$\u2014")
        app.pressEscape()
        yield* app.waitGone("Used       ")

        yield* Effect.tryPromise(() => app.type("Fail this turn."))
        app.pressEnter()
        yield* app.waitFrame("Execution failed")
        yield* app.settled
        yield* app.clickText("ctx")
        const settledFrame = yield* app.waitFrame("Used")
        expect(settledFrame).toContain("1.2K")
        expect(settledFrame).not.toContain("$\u2014")
        yield* app.quit
      }),
    ),
  tuiTestTimeout,
)

test("never renders a blank frame between final preview and durable answer", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30 })
  const surface = new Surface(setup.renderer, { key: () => undefined, resize: () => undefined })
  try {
    const threadId = Thread.ThreadId.make("thread")
    const turnId = Turn.TurnId.make("turn")
    const marker = "FINAL_HANDOFF_MARKER"
    const thread: Thread.Thread = {
      id: threadId,
      workspace: "/workspace",
      title: "Thread",
      labels: [],
      pinned: false,
      archived: false,
      lineage: { _tag: "Original" },
      createdAt: 1,
      updatedAt: 1,
    }
    const turn: ThreadView.ThreadViewTurnRecord = {
      kind: "agent",
      id: turnId,
      threadId,
      prompt: "prompt",
      status: "running",
      author: { _tag: "Human" },
      lineage: { _tag: "Original" },
      createdAt: 1,
      updatedAt: 1,
    }
    const promptKey = "turn:user"
    const snapshot = (): ThreadView.ThreadViewSnapshot => ({
      thread,
      revision: 0,
      source: { projectionVersion: 1 },
      turns: [
        {
          turn,
          projectionRevision: 0,
          usage: ExecutionProjection.emptyUsageState(),
          units: [
            {
              key: promptKey,
              turnId,
              order: TranscriptOrdering.unitOrder(promptKey, -1),
              revision: 0,
              content: { _tag: "Entry", role: "user", text: "prompt" },
            },
          ],
        },
      ],
      pending: [],
      hasOlder: false,
      hasNewer: false,
      usage: { state: ExecutionProjection.emptyUsageState() },
    })
    const previewEvent = (): Extract<
      InteractiveEvent.InteractiveEvent,
      { readonly _tag: "ExecutionModelPreviewChanged" }
    > => ({
      _tag: "ExecutionModelPreviewChanged",
      threadId,
      turnId,
      preview: {
        _tag: "ModelPreview",
        runId: "run",
        attemptFence: 1,
        turn: 0,
        modelCallId: "call",
        modelAttemptId: "attempt-1",
        attempt: 1,
        sequence: 0,
        changes: [{ channel: "text", offset: 0, delta: marker }],
      },
    })
    const handoffEvent = (): Extract<
      InteractiveEvent.InteractiveEvent,
      { readonly _tag: "ExecutionModelPreviewChanged" }
    > => ({
      _tag: "ExecutionModelPreviewChanged",
      threadId,
      turnId,
      preview: { _tag: "ModelPreviewCleared", runId: "run", attemptFence: 1, generation: 0 },
    })
    const loaded = () =>
      InteractiveController.update(
        { model: TerminalState.initial("/workspace", "medium") },
        { _tag: "ThreadViewSnapshot", snapshot: snapshot() },
      ).state
    const patchWith = (
      state: InteractiveController.State,
      upsert: ReadonlyArray<TranscriptUnit.Unit>,
      status: ThreadView.ThreadViewTurnRecord["status"] | undefined,
    ): InteractiveController.State => {
      const view = state.view!
      const entry = view.turn(String(turnId))!
      return InteractiveController.update(
        state,
        {
          _tag: "ThreadViewPatch",
          patch: {
            threadId,
            baseRevision: view.revision,
            revision: view.revision + 1,
            upsert: [...upsert],
            remove: [],
            turnChanges:
              status === undefined
                ? []
                : [
                    {
                      _tag: "UpsertTurn",
                      turn: { ...entry.turn, status, updatedAt: entry.turn.updatedAt + 1 },
                      projectionRevision: entry.projectionRevision + 1,
                      usage: entry.usage,
                    },
                  ],
          },
        },
      ).state
    }
    const durableKey = "durable:answer"
    const durableUnit = (): TranscriptUnit.Unit => ({
      key: durableKey,
      turnId,
      order: TranscriptOrdering.unitOrder(durableKey, 1),
      revision: 1,
      content: { _tag: "Entry", role: "assistant", text: marker },
      modelResponseId: modelResponseId({
        runId: "run",
        turn: 0,
        modelCallId: "call",
        modelAttemptId: "attempt-1",
        attempt: 1,
      }),
    })
    const frames: Array<string> = []
    const capture = async (state: InteractiveController.State): Promise<void> => {
      surface.update(state.model)
      await setup.flush()
      frames.push(setup.captureCharFrame())
    }
    let state = loaded()
    state = InteractiveController.update(state, previewEvent()).state
    await capture(state)
    // Commit-handoff holds the final preview text while the durable write lands.
    state = InteractiveController.update(state, handoffEvent()).state
    await capture(state)
    // Completed Turn status outruns the durable patch and must not blank the answer.
    state = patchWith(state, [], "completed")
    await capture(state)
    state = patchWith(state, [durableUnit()], undefined)
    await capture(state)
    expect(frames[0]).toContain(marker)
    const blank = frames.filter((frame) => !frame.includes(marker))
    expect(blank).toEqual([])
  } finally {
    surface.destroy()
    setup.renderer.destroy()
  }
}, tuiTestTimeout)
