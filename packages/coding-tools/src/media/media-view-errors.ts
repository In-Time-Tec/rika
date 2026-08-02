import { Schema } from "effect"

export class MediaAnalysisError extends Schema.TaggedErrorClass<MediaAnalysisError>()("MediaAnalysisError", {
  message: Schema.String,
}) {}
export class MediaMissingError extends Schema.TaggedErrorClass<MediaMissingError>()("MediaMissingError", {
  path: Schema.String,
}) {}
export class MediaOversizedError extends Schema.TaggedErrorClass<MediaOversizedError>()("MediaOversizedError", {
  path: Schema.String,
  size: Schema.Finite,
  maximum: Schema.Finite,
}) {}
export class UnsupportedMediaError extends Schema.TaggedErrorClass<UnsupportedMediaError>()("UnsupportedMediaError", {
  path: Schema.String,
}) {}
