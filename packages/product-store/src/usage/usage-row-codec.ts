import { Schema } from "effect"

export const UsageRow = Schema.Struct({
  source_id: Schema.String,
  turn_id: Schema.String,
  thread_id: Schema.String,
  revision: Schema.Finite,
  projection_version: Schema.Finite,
  fold_json: Schema.NullOr(Schema.String),
  cost_nano_usd: Schema.NullOr(Schema.Finite),
  tokens: Schema.NullOr(Schema.Finite),
  active_millis: Schema.NullOr(Schema.Finite),
  active_intervals_json: Schema.NullOr(Schema.String),
  priced_attempts: Schema.Finite,
  unpriced_attempts: Schema.Finite,
  counted_attempts: Schema.Finite,
  uncounted_attempts: Schema.Finite,
  source_complete: Schema.Finite,
  updated_at: Schema.Finite,
})
