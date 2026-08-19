import { Schema } from "effect"

export const MediaKind = Schema.Literals(["image", "pdf", "audio", "video"])
export type MediaKind = typeof MediaKind.Type

export const AnalysisInput = Schema.Struct({
  path: Schema.String,
  mimeType: Schema.String,
  kind: MediaKind,
  size: Schema.Finite,
  bytes: Schema.Uint8Array,
})
export type AnalysisInput = typeof AnalysisInput.Type

export const Artifact = Schema.Struct({
  path: Schema.String,
  mimeType: Schema.String,
  kind: MediaKind,
  size: Schema.Finite,
  width: Schema.optionalKey(Schema.Finite),
  height: Schema.optionalKey(Schema.Finite),
})
export type Artifact = typeof Artifact.Type

export const Output = Schema.Struct({ text: Schema.String, artifact: Artifact, truncated: Schema.Boolean })
export type Output = typeof Output.Type
