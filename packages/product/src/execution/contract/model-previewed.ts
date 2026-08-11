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
  text: Schema.String.check(Schema.isMaxLength(ModelPreviewMaxCharacters)),
  reasoning: Schema.String.check(Schema.isMaxLength(ModelPreviewMaxCharacters)),
  truncated: Schema.Boolean,
}).check(
  Schema.makeFilter((preview) =>
    preview.text.length + preview.reasoning.length <= ModelPreviewMaxCharacters
      ? []
      : [{ path: ["reasoning"], issue: `combined preview exceeds ${ModelPreviewMaxCharacters} characters` }],
  ),
)
export type ModelPreviewed = typeof ModelPreviewed.Type
