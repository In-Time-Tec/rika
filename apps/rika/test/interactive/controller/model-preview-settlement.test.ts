import { expect, it } from "@effect/vitest"
import { modelResponseId } from "@rika/product/execution-gateway"
import type * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import * as Thread from "@rika/product/thread-record"
import * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import * as TranscriptOrdering from "@rika/transcript/transcript-unit-order"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import * as TerminalState from "@rika/terminal/terminal-state"
import * as InteractiveController from "../../../src/interactive/controller/service"

const threadId = Thread.ThreadId.make("thread")
const turnId = Turn.TurnId.make("turn")
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

const preview = (text: string): Extract<
  import("@rika/product/interactive-event").InteractiveEvent,
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
    changes: [
      { channel: "reasoning", offset: 0, delta: "" },
      { channel: "text", offset: 0, delta: text },
    ],
  },
})

const cleared = (): Extract<
  import("@rika/product/interactive-event").InteractiveEvent,
  { readonly _tag: "ExecutionModelPreviewChanged" }
> => ({
  _tag: "ExecutionModelPreviewChanged",
  threadId,
  turnId,
  preview: {
    _tag: "ModelPreviewCleared",
    runId: "run",
    attemptFence: 1,
    generation: 1,
  },
})

const responseIdentity = (): string =>
  modelResponseId({
    runId: "run",
    turn: 0,
    modelCallId: "call",
    modelAttemptId: "attempt-1",
    attempt: 1,
  })

const loaded = (): InteractiveController.State =>
  InteractiveController.update(
    { model: TerminalState.initial("/workspace", "medium") },
    { _tag: "ThreadViewSnapshot", snapshot: snapshot() },
  ).state

const patch = (
  state: InteractiveController.State,
  options: {
    readonly status?: ThreadView.ThreadViewTurnRecord["status"]
    readonly upsert?: ReadonlyArray<TranscriptUnit.Unit>
  },
): InteractiveController.State => {
  const view = state.view!
  const entry = view.turn(String(turnId))!
  const event: ThreadView.ThreadViewPatch = {
    threadId,
    baseRevision: view.revision,
    revision: view.revision + 1,
    upsert: options.upsert ?? [],
    remove: [],
    turnChanges:
      options.status === undefined
        ? []
        : [
            {
              _tag: "UpsertTurn",
              turn: {
                ...entry.turn,
                status: options.status,
                updatedAt: entry.turn.updatedAt + 1,
              },
              projectionRevision: entry.projectionRevision + 1,
              usage: entry.usage,
            },
          ],
  }
  return InteractiveController.update(state, { _tag: "ThreadViewPatch", patch: event }).state
}

const assistantTexts = (state: InteractiveController.State): ReadonlyArray<string> =>
  state.model.entries.filter((entry) => entry.role === "assistant").map((entry) => entry.text)

it("keeps a cleared final preview visible until the matching durable response arrives", () => {
  const text = "The final answer stays visible during settlement."
  let state = InteractiveController.update(loaded(), preview(text)).state
  state = InteractiveController.update(state, cleared()).state

  expect(assistantTexts(state)).toEqual([text])
  expect(state.modelPreview).toBeDefined()

  state = patch(state, { status: "completed" })

  expect(assistantTexts(state)).toEqual([text])
  expect(state.modelPreview).toBeDefined()

  const durable: TranscriptUnit.Unit = {
    key: "turn:assistant",
    turnId,
    order: TranscriptOrdering.unitOrder("turn:assistant", 1),
    revision: 1,
    modelResponseId: responseIdentity(),
    content: { _tag: "Entry", role: "assistant", text },
  }
  state = patch(state, { upsert: [durable] })

  expect(assistantTexts(state)).toEqual([text])
  expect(state.modelPreview).toBeUndefined()
})
