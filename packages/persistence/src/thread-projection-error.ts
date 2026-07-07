import { Ids } from "@rika/schema"
import { Schema } from "effect"

export class ThreadProjectionError extends Schema.TaggedErrorClass<ThreadProjectionError>()("ThreadProjectionError", {
  message: Schema.String,
  operation: Schema.String,
  thread_id: Schema.optional(Ids.ThreadId),
}) {}
