import { Schema } from "effect"

export const ModelPreviewMaxCharacters = 4_096

export const ModelPreviewKey = Schema.Struct({
  runId: Schema.String,
  attemptFence: Schema.Int,
  turn: Schema.Int,
  modelCallId: Schema.String,
  modelAttemptId: Schema.String,
  attempt: Schema.Int,
})
export type ModelPreviewKey = typeof ModelPreviewKey.Type

export const ModelPreviewed = Schema.Struct({
  _tag: Schema.tag("ModelPreviewed"),
  key: ModelPreviewKey,
  revision: Schema.Int,
  text: Schema.String,
  reasoning: Schema.String,
  truncated: Schema.Boolean,
})
export type ModelPreviewed = typeof ModelPreviewed.Type
