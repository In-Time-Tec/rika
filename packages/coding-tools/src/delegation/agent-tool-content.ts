import { Schema } from "effect"

const Metadata = Schema.Record(Schema.String, Schema.Json)
const Common = {
  provider_options: Schema.optionalKey(Metadata),
  metadata: Schema.optionalKey(Metadata),
}

export const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String, ...Common })
export const Structured = Schema.Struct({
  type: Schema.Literal("structured"),
  value: Schema.Json,
  schema_ref: Schema.optionalKey(Schema.String),
  ...Common,
})
export const BlobReference = Schema.Struct({
  type: Schema.Literal("blob-reference"),
  uri: Schema.String,
  media_type: Schema.String,
  filename: Schema.optionalKey(Schema.String),
  ...Common,
})
export const ArtifactReference = Schema.Struct({
  type: Schema.Literal("artifact-reference"),
  artifact_id: Schema.String,
  media_type: Schema.optionalKey(Schema.String),
  ...Common,
})
export const ToolCall = Schema.Struct({
  type: Schema.Literal("tool-call"),
  call: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    input: Schema.Json,
    metadata: Schema.optionalKey(Metadata),
  }),
  ...Common,
})
export const ToolResult = Schema.Struct({
  type: Schema.Literal("tool-result"),
  result: Schema.Struct({
    call_id: Schema.String,
    output: Schema.Json,
    error: Schema.optionalKey(Schema.String),
    metadata: Schema.optionalKey(Metadata),
  }),
  ...Common,
})
export const Content = Schema.Union([Text, Structured, BlobReference, ArtifactReference, ToolCall, ToolResult])
export type Content = typeof Content.Type
