import { Schema } from "effect"

const SourceSequence = Schema.Finite.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)

export const SourceEvent = Schema.Struct({
  childExecutionId: Schema.optionalKey(Schema.String),
  cursor: Schema.String,
  sequence: SourceSequence,
  type: Schema.String,
  createdAt: Schema.Finite,
  text: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type SourceEvent = typeof SourceEvent.Type
