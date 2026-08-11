import { expect, test } from "vitest"
import { Effect } from "effect"
import type * as InteractiveEvent from "@rika/product/interactive-event"
import * as TuiApp from "./tui-app"
import { model } from "./tui-app-model"

const tuiTestTimeout = 60_000

type ModelPreviewEvent = Extract<InteractiveEvent.InteractiveEvent, { readonly _tag: "ExecutionModelPreviewed" }>

const injectModelPreview = (content: { readonly text: string; readonly reasoning: string }) => {
  let active: Pick<ModelPreviewEvent, "threadId" | "turnId"> | undefined
  let retained: ModelPreviewEvent | undefined
  let retainedDeliveries = 0
  return (event: InteractiveEvent.InteractiveEvent): InteractiveEvent.InteractiveEvent => {
    if (event._tag !== "ThreadViewPatch") return event
    if (retained !== undefined) {
      retainedDeliveries += 1
      return retainedDeliveries <= 10 ? retained : event
    }
    if (active === undefined) {
      const change = event.patch.turnChanges.find((candidate) => candidate._tag === "UpsertTurn") as
        | { readonly turn: { readonly id: ModelPreviewEvent["turnId"] } }
        | undefined
      if (change !== undefined) active = { threadId: event.patch.threadId, turnId: change.turn.id }
      return event
    }
    const preview: ModelPreviewEvent = {
      _tag: "ExecutionModelPreviewed",
      threadId: active.threadId,
      turnId: active.turnId,
      preview: {
        _tag: "ModelPreviewed",
        key: {
          runId: "tui-activity-run",
          attemptFence: 1,
          turn: 0,
          modelCallId: "tui-activity-call",
          modelAttemptId: "tui-activity-attempt",
          attempt: 1,
        },
        revision: 1,
        ...content,
        truncated: false,
      },
    }
    retained = preview
    return preview
  }
}

test(
  "shows thinking and streaming token activity from live model previews",
  () =>
    TuiApp.run(
      Effect.gen(function* () {
        const thinking = yield* TuiApp.tuiApp({
          script: [model.text("THINKING_DONE", 1_500)],
          mapInteractiveEvent: injectModelPreview({ text: "", reasoning: "12345678" }),
        })
        yield* Effect.promise(() => thinking.type("Think first."))
        thinking.pressEnter()
        expect(yield* thinking.waitFrame("Thinking 2 tok")).toContain("Thinking 2 tok")
        yield* thinking.waitFrame("THINKING_DONE")
        yield* thinking.settled
        thinking.close()
        yield* thinking.done

        const streaming = yield* TuiApp.tuiApp({
          script: [model.text("STREAMING_DONE", 1_500)],
          mapInteractiveEvent: injectModelPreview({ text: "123456789012", reasoning: "12345678" }),
        })
        yield* Effect.promise(() => streaming.type("Answer now."))
        streaming.pressEnter()
        expect(yield* streaming.waitFrame("Streaming 3 tok")).toContain("Streaming 3 tok")
        yield* streaming.waitFrame("STREAMING_DONE")
        yield* streaming.settled
        streaming.close()
        yield* streaming.done
      }),
    ),
  tuiTestTimeout,
)
