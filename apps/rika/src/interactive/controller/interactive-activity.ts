import * as InteractiveEvent from "@rika/product/interactive-event"
import * as TranscriptProjectionModel from "@rika/transcript/transcript-projection-model"
import * as TranscriptSourceEvent from "@rika/transcript/transcript-source-event"
import type { Model } from "@rika/terminal/terminal-state"
import { Function } from "effect"
import { runningToolsActivity, streamActivity } from "@rika/terminal/terminal-message"
import type { ProjectionStream } from "./interactive-controller"

type Activity = NonNullable<Model["activity"]>
type OpenProjectionState = Extract<ProjectionStream, { readonly _tag: "Open" }>["state"]

const sourceText = (event: TranscriptSourceEvent.SourceEvent): string => {
  if (typeof event.text === "string") return event.text
  const delta = event.data?.delta
  return typeof delta === "string" ? delta : ""
}

const sourceBlockId = (event: TranscriptSourceEvent.SourceEvent, fallback: string): string => {
  const id = event.data?.tool_call_id ?? event.data?.call_id ?? event.data?.id
  return typeof id === "string" ? id : fallback
}

const activityAfter = (
  activity: Activity | undefined,
  event: TranscriptSourceEvent.SourceEvent,
  projection: TranscriptProjectionModel.Projection,
  model: Model,
): Activity | undefined => {
  const runningActivity = runningToolsActivity(model)
  const running =
    runningActivity._tag === "RunningTools" && (runningActivity.subagents ?? 0) + (runningActivity.tools ?? 0) > 0
  if (event.type.includes("reasoning"))
    return running
      ? runningActivity
      : streamActivity(activity, "Thinking", sourceText(event), `reasoning:${projection.modelPhase}`)
  if (event.type === "model.output.delta")
    return running
      ? runningActivity
      : streamActivity(activity, "Streaming", sourceText(event), `answer:${projection.modelPhase}`)
  if (event.type === "model.toolcall.delta")
    return running
      ? runningActivity
      : streamActivity(activity, "Streaming", sourceText(event), sourceBlockId(event, "tool"))
  if (event.type === "tool.call.requested" || event.type === "tool.call.executing" || event.type === "tool.started")
    return runningActivity
  if (event.type === "tool.result.received") return running ? runningActivity : { _tag: "Waiting" }
  if (
    event.type === "execution.accepted" ||
    event.type === "execution.started" ||
    event.type === "model.input.prepared" ||
    event.type === "model.output.completed"
  )
    return running ? runningActivity : { _tag: "Waiting" }
  if (
    event.type === "execution.completed" ||
    event.type === "execution.failed" ||
    event.type === "execution.cancelled"
  ) {
    if (running) return runningActivity
    return model.busy ? { _tag: "Waiting" } : undefined
  }
  return running ? runningActivity : activity
}

const activityAfterOriginImpl = (
  activity: Activity | undefined,
  origin: Extract<InteractiveEvent.InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>["origin"],
  state: OpenProjectionState,
  model: Model,
): Activity | undefined => {
  if (origin._tag === "Discovery") return runningToolsActivity(model)
  if (origin._tag === "RecordedShell") return activity
  return activityAfter(
    activity,
    {
      cursor: origin.cursor,
      sequence: origin.sequence,
      type: origin.type,
      createdAt: origin.createdAt,
      ...(origin.text === undefined ? {} : { text: origin.text }),
    },
    {
      units: [],
      revision: state.revision,
      modelPhase: state.modelPhase,
      ...(state.usableCompletionSequence === undefined
        ? {}
        : { usableCompletionSequence: state.usableCompletionSequence }),
    },
    model,
  )
}

export const activityAfterOrigin: {
  (
    activity: Activity | undefined,
    origin: Extract<InteractiveEvent.InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>["origin"],
    state: OpenProjectionState,
  ): (model: Model) => Activity | undefined
  (
    activity: Activity | undefined,
    origin: Extract<InteractiveEvent.InteractiveEvent, { readonly _tag: "TranscriptProjectionPatched" }>["origin"],
    state: OpenProjectionState,
    model: Model,
  ): Activity | undefined
} = Function.dual(4, activityAfterOriginImpl)
