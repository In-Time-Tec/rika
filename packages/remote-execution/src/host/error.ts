import { Schema } from "effect"

export class HostError extends Schema.TaggedError<HostError>()("HostError", {
  message: Schema.String,
  // A permanent failure means this bootstrap identity can never be admitted again (fenced or
  // authorized for a different environment), so reconnecting with it is pointless.
  permanent: Schema.optionalKey(Schema.Boolean),
}) {}
