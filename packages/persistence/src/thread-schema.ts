import { Schema } from "effect"

export const ThreadId = Schema.String.pipe(Schema.brand("RikaThreadId"))
export type ThreadId = typeof ThreadId.Type

export const Thread = Schema.Struct({
  id: ThreadId,
  workspace: Schema.String,
  title: Schema.String,
  labels: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
  archived: Schema.Boolean,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
})
export type Thread = typeof Thread.Type
