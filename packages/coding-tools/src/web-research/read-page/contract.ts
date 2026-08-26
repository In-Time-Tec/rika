import { Schema } from "effect"

export const Input = Schema.Struct({
  url: Schema.String,
  objective: Schema.optionalKey(Schema.String),
  fullContent: Schema.optionalKey(Schema.Boolean),
  forceRefetch: Schema.optionalKey(Schema.Boolean),
})
export type Input = typeof Input.Type
