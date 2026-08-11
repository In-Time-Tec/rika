import { ModelPreview as RuntimeModelPreview } from "@batonfx/runtime"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
import { Stream } from "effect"

export const modelPreviewed = (preview: RuntimeModelPreview.ModelPreview): ExecutionGateway.ModelPreviewed => {
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

export const modelPreviewCleared = (
  frame: RuntimeModelPreview.PreviewCleared,
): ExecutionGateway.ModelPreviewCleared => ({
  _tag: "ModelPreviewCleared",
  runId: frame.runId,
  attemptFence: frame.attemptFence,
  generation: frame.generation,
})

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

export const merge = <E>(input: {
  readonly projections: Stream.Stream<ExecutionProjection.Change, E>
  readonly previews: Stream.Stream<RuntimeModelPreview.PreviewFrame>
}): Stream.Stream<ExecutionGateway.WatchEvent, E> =>
  Stream.merge(
    input.projections,
    Stream.map(input.previews, (frame) => ("_tag" in frame ? modelPreviewCleared(frame) : modelPreviewed(frame))),
    { haltStrategy: "left" },
  )
