import { Schema } from "effect"

const ModelPreviewMaxPayloadCharacters = 4_096

const ModelPreviewIdentity = Schema.Struct({
  runId: Schema.String,
  attemptFence: Schema.Int,
  turn: Schema.Int,
  modelCallId: Schema.String,
  modelAttemptId: Schema.String,
  attempt: Schema.Int,
})
export type ModelPreviewIdentity = typeof ModelPreviewIdentity.Type

export const ModelPreviewChange = Schema.Struct({
  channel: Schema.Literals(["reasoning", "text"]),
  offset: Schema.Int,
  delta: Schema.String,
})
export type ModelPreviewChange = typeof ModelPreviewChange.Type

export const ModelPreviewFrame = Schema.Struct({
  _tag: Schema.tag("ModelPreview"),
  ...ModelPreviewIdentity.fields,
  sequence: Schema.Int,
  changes: Schema.NonEmptyArray(ModelPreviewChange),
}).check(
  Schema.makeFilter((frame) =>
    frame.changes.reduce((characters, change) => characters + change.delta.length, 0) <=
    ModelPreviewMaxPayloadCharacters
      ? []
      : [{ path: ["changes"], issue: `frame payload exceeds ${ModelPreviewMaxPayloadCharacters} characters` }],
  ),
)
export type ModelPreviewFrame = typeof ModelPreviewFrame.Type

const ModelPreviewCleared = Schema.Struct({
  _tag: Schema.tag("ModelPreviewCleared"),
  runId: Schema.String,
  attemptFence: Schema.Int,
  generation: Schema.Int,
})

export const ModelPreviewEvent = Schema.Union([ModelPreviewFrame, ModelPreviewCleared])
export type ModelPreviewEvent = typeof ModelPreviewEvent.Type
