import { Schema } from "effect"

export const QueueItem = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  delivery: Schema.optionalKey(Schema.Literals(["steer", "followUp"])),
  attachments: Schema.optionalKey(Schema.Array(Schema.String)),
  provisional: Schema.optionalKey(Schema.Literal(true)),
})
export type QueueItem = typeof QueueItem.Type
