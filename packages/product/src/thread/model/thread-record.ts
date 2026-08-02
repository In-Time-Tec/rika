import { Schema } from "effect"

export const ThreadId = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/)).pipe(Schema.brand("RikaThreadId"))
export type ThreadId = typeof ThreadId.Type

export const ThreadLineage = Schema.Union([
  Schema.TaggedStruct("Original", {}),
  Schema.TaggedStruct("Fork", {
    sourceThreadId: ThreadId,
    sourceTurnId: Schema.optionalKey(
      Schema.String.check(Schema.isPattern(/^[\x21-\x7e]+$/)).pipe(Schema.brand("RikaTurnId")),
    ),
  }),
])
export type ThreadLineage = typeof ThreadLineage.Type

export const Thread = Schema.Struct({
  id: ThreadId,
  workspace: Schema.String,
  title: Schema.String,
  labels: Schema.Array(Schema.String),
  pinned: Schema.Boolean,
  archived: Schema.Boolean,
  lineage: ThreadLineage,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
})
export type Thread = typeof Thread.Type
