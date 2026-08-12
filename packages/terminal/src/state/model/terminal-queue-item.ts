import { Schema } from "effect"

export const QueueItem = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  attachments: Schema.optionalKey(Schema.Array(Schema.String)),
  provisional: Schema.optionalKey(Schema.Literal(true)),
  threadId: Schema.optionalKey(Schema.String),
})
export type QueueItem = typeof QueueItem.Type
