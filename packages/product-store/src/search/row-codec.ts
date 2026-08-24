import { Schema } from "effect"


export const ThreadSearchRow = Schema.Struct({
  id: Schema.String,
  workspace: Schema.String,
  title: Schema.String,
  labels_json: Schema.String,
  pinned: Schema.Finite,
  archived: Schema.Finite,
  lineage_json: Schema.String,
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
  search_title: Schema.String,
  search_labels: Schema.String,
  human_prompts: Schema.String,
  agent_prompts: Schema.String,
  root_assistant: Schema.String,
  child_assistant: Schema.String,
  files: Schema.String,
})
