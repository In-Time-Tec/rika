import { Schema } from "effect"

export const LocalPathReason = Schema.Literals(["not_found", "ambiguous_case", "outside_workspace"])
export type LocalPathReason = typeof LocalPathReason.Type

export class LocalPathError extends Schema.TaggedErrorClass<LocalPathError>()("LocalPathError", {
  path: Schema.String,
  reason: LocalPathReason,
  candidates: Schema.Array(Schema.String),
}) {}
