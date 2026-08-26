import { Schema } from "effect"

export const ThreadRow = Schema.Struct({
  id: Schema.String,
  workspace: Schema.String,
  title: Schema.String,
  labels_json: Schema.String,
  pinned: Schema.Finite,
  archived: Schema.Finite,
  lineage_json: Schema.String,
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})
