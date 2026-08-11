import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionProjection from "@rika/product/execution-projection"
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
  readonly previews: (input: { readonly runId: string }) => Stream.Stream<RuntimeModelPreview>
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

export const merge = <E>(input: {
  readonly projections: Stream.Stream<ExecutionProjection.Change, E>
  readonly previews: Stream.Stream<RuntimeModelPreview>
}): Stream.Stream<ExecutionGateway.WatchEvent, E> =>
  Stream.merge(input.projections, Stream.map(input.previews, modelPreviewed), { haltStrategy: "left" })
