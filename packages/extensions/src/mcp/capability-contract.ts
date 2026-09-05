import { Schema } from "effect"
import { Specialist } from "./configuration"

/** Only tool metadata crosses the Executor boundary, never connection configuration or credentials. */
export const Capability = Schema.Struct({
  specialist: Specialist,
  server: Schema.NonEmptyString,
  sourceDigest: Schema.String,
  name: Schema.NonEmptyString,
  rawName: Schema.NonEmptyString,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Json),
  outputSchema: Schema.Json,
})
export type Capability = typeof Capability.Type
export const Catalog = Schema.Array(Capability)
