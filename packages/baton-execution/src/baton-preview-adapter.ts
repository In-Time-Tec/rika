import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import type { ModelPreview } from "@batonfx/runtime"
import { Stream } from "effect"

export interface RuntimeModelPreview {
  readonly runId: string
  readonly attemptFence: number
  readonly turn: number
  readonly modelCallId: string
  readonly modelAttemptId: string
  readonly attempt: number
  readonly revision: number
  readonly text: string
  readonly reasoning: string
  readonly truncated: boolean
}

export interface PreviewRuntime {
  readonly previews: (input: { readonly runId: string }) => Stream.Stream<ModelPreview.Event>
}

interface Channel {
  readonly visible: string
  readonly total: number
}

interface AccumulatedPreview {
  readonly preview: RuntimeModelPreview
  readonly text: Channel
  readonly reasoning: Channel
  readonly incomplete: boolean
}

export const modelPreviewed = (preview: RuntimeModelPreview): ExecutionGateway.ModelPreviewed => {
  const text = preview.text.slice(0, ExecutionGateway.ModelPreviewMaxCharacters)
  const reasoning = preview.reasoning.slice(0, ExecutionGateway.ModelPreviewMaxCharacters - text.length)
  return {
    _tag: "ModelPreviewed",
    key: {
      runId: preview.runId,
      attemptFence: preview.attemptFence,
      turn: preview.turn,
      modelCallId: preview.modelCallId,
      modelAttemptId: preview.modelAttemptId,
      attempt: preview.attempt,
    },
    revision: preview.revision,
    text,
    reasoning,
    truncated: preview.truncated || text.length < preview.text.length || reasoning.length < preview.reasoning.length,
  }
}

export const previewIdentity = (preview: ExecutionGateway.ModelPreviewed): string =>
  JSON.stringify([
    preview.key.runId,
    preview.key.attemptFence,
    preview.key.turn,
    preview.key.modelCallId,
    preview.key.modelAttemptId,
    preview.key.attempt,
  ])

export const replacePreview = (input: {
  readonly current: ReadonlyMap<string, ExecutionGateway.ModelPreviewed>
  readonly preview: ExecutionGateway.ModelPreviewed
}): ReadonlyMap<string, ExecutionGateway.ModelPreviewed> => {
  const identity = previewIdentity(input.preview)
  const previous = input.current.get(identity)
  if (previous !== undefined && previous.revision >= input.preview.revision) return input.current
  const next = new Map(input.current)
  next.set(identity, input.preview)
  return next
}

const append = (channel: Channel, change: ModelPreview.Change): Channel => {
  const total = change.offset + change.delta.length
  if (change.offset === channel.total)
    return {
      visible: `${channel.visible}${change.delta}`.slice(0, ExecutionGateway.ModelPreviewMaxCharacters),
      total,
    }
  if (change.offset === 0) return { visible: change.delta.slice(0, ExecutionGateway.ModelPreviewMaxCharacters), total }
  return {
    visible: `…${change.delta}`.slice(-ExecutionGateway.ModelPreviewMaxCharacters),
    total,
  }
}

const frameIdentity = (frame: ModelPreview.Frame): string =>
  JSON.stringify([frame.runId, frame.attemptFence, frame.turn, frame.modelCallId, frame.modelAttemptId, frame.attempt])

export const accumulate = (
  events: Stream.Stream<ModelPreview.Event>,
): Stream.Stream<ExecutionGateway.ModelPreviewed> => {
  const current = new Map<string, AccumulatedPreview>()
  return events.pipe(
    Stream.map((event): ReadonlyArray<ExecutionGateway.ModelPreviewed> => {
      if (event._tag === "ModelPreviewCleared") {
        const cleared: Array<ExecutionGateway.ModelPreviewed> = []
        for (const [identity, state] of current) {
          if (state.preview.runId !== event.runId || state.preview.attemptFence !== event.attemptFence) continue
          current.delete(identity)
          cleared.push(
            modelPreviewed({
              ...state.preview,
              revision: state.preview.revision + 1,
              text: "",
              reasoning: "",
              truncated: false,
            }),
          )
        }
        return cleared
      }
      const identity = frameIdentity(event)
      const previous = current.get(identity)
      if (previous !== undefined && event.sequence <= previous.preview.revision) return []
      let text = previous?.text ?? { visible: "", total: 0 }
      let reasoning = previous?.reasoning ?? { visible: "", total: 0 }
      let incomplete =
        previous?.incomplete === true ||
        (previous === undefined ? event.sequence !== 0 : event.sequence !== previous.preview.revision + 1)
      for (const change of event.changes) {
        const channel = change.channel === "text" ? text : reasoning
        if (change.offset !== channel.total) incomplete = true
        if (change.channel === "text") text = append(text, change)
        else reasoning = append(reasoning, change)
      }
      const preview: RuntimeModelPreview = {
        runId: event.runId,
        attemptFence: event.attemptFence,
        turn: event.turn,
        modelCallId: event.modelCallId,
        modelAttemptId: event.modelAttemptId,
        attempt: event.attempt,
        revision: event.sequence,
        text: text.visible,
        reasoning: reasoning.visible,
        truncated: incomplete || text.total + reasoning.total > ExecutionGateway.ModelPreviewMaxCharacters,
      }
      current.set(identity, { preview, text, reasoning, incomplete })
      return [modelPreviewed(preview)]
    }),
    Stream.flatMap(Stream.fromIterable),
  )
}

export const merge = <E>(input: {
  readonly projections: Stream.Stream<ExecutionProjection.Change, E>
  readonly previews: Stream.Stream<ModelPreview.Event>
}): Stream.Stream<ExecutionGateway.WatchEvent, E> =>
  Stream.merge(input.projections, accumulate(input.previews), { haltStrategy: "left" })
