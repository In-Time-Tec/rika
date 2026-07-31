import { Schema } from "effect"

export const TranscriptCheckpointRow = Schema.Struct({
  turn_id: Schema.String,
  thread_id: Schema.String,
  checkpoint_generation: Schema.Finite,
  revision: Schema.Finite,
  projection_version: Schema.Finite,
  model_phase: Schema.Finite,
  usable_completion_sequence: Schema.NullOr(Schema.Finite),
  oldest_cursor: Schema.NullOr(Schema.String),
  checkpoint_cursor: Schema.NullOr(Schema.String),
  cost_usd: Schema.NullOr(Schema.Finite),
  usage_cursors_json: Schema.NullOr(Schema.String),
  pricing_version: Schema.NullOr(Schema.String),
  updated_at: Schema.Finite,
})
