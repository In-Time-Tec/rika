import { Schema } from "effect"
import { OutputTokenTotals } from "../usage/token-totals"

const ModelPreviewMaxPayloadCharacters = 4_096

const ModelPreviewIdentity = Schema.Struct({
  runId: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  attemptFence: Schema.Int,
  turn: Schema.Int,
  modelCallId: Schema.String,
  modelAttemptId: Schema.String,
  attempt: Schema.Int,
})
export type ModelPreviewIdentity = typeof ModelPreviewIdentity.Type

type ModelResponseIdentity = Pick<ModelPreviewIdentity, "runId" | "turn" | "modelCallId" | "modelAttemptId" | "attempt">

const hashIdentity = (value: string): string => {
  const seeds = [0x811c9dc5, 0x9e3779b1, 0x85ebca77, 0xc2b2ae3d]
  return seeds
    .map((seed) => {
      let result = seed >>> 0
      for (let index = 0; index < value.length; index += 1) {
        result ^= value.charCodeAt(index)
        result = Math.imul(result, 0x01000193) >>> 0
      }
      return result.toString(16).padStart(8, "0")
    })
    .join("")
}

export const modelResponseId = (identity: ModelResponseIdentity): string => {
  const parts = [identity.runId, identity.turn, identity.modelCallId, identity.modelAttemptId, identity.attempt]
  const canonical = parts.map((part) => `${String(part).length}:${part}`).join("")
  return `model-response-${hashIdentity(canonical)}`
}

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

export const ModelPreviewUsage = Schema.Struct({
  _tag: Schema.tag("ModelPreviewUsage"),
  runId: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  turn: Schema.Int,
  modelCallId: Schema.String,
  modelAttemptId: Schema.String,
  attempt: Schema.Int,
  completedAt: Schema.Finite,
  outputTokens: OutputTokenTotals,
})
export type ModelPreviewUsage = typeof ModelPreviewUsage.Type

const ModelPreviewCleared = Schema.Struct({
  _tag: Schema.tag("ModelPreviewCleared"),
  runId: Schema.String,
  parentId: Schema.optionalKey(Schema.String),
  attemptFence: Schema.Int,
  generation: Schema.Int,
})

export const ModelPreviewEvent = Schema.Union([ModelPreviewFrame, ModelPreviewUsage, ModelPreviewCleared])
export type ModelPreviewEvent = typeof ModelPreviewEvent.Type
