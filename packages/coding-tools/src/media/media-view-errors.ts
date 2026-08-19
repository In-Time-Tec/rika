import { Schema } from "effect"

export class MediaAnalysisError extends Schema.TaggedError<MediaAnalysisError>()("MediaAnalysisError", {
  message: Schema.String,
}) {}
export class MediaMissingError extends Schema.TaggedError<MediaMissingError>()("MediaMissingError", {
  path: Schema.String,
}) {}
export class MediaOversizedError extends Schema.TaggedError<MediaOversizedError>()("MediaOversizedError", {
  path: Schema.String,
  size: Schema.Finite,
  maximum: Schema.Finite,
}) {}
export class UnsupportedMediaError extends Schema.TaggedError<UnsupportedMediaError>()("UnsupportedMediaError", {
  path: Schema.String,
}) {}
