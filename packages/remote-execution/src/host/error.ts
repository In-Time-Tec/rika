import { Schema } from "effect"

export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  message: Schema.String,
}) {}
