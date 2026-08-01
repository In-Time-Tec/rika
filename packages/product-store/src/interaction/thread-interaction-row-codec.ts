import { Schema } from "effect"

export const InvocationReceiptRow = Schema.Struct({
  schema_input_digest: Schema.String,
  kind: Schema.String,
  outcome: Schema.String,
})

export const ResultRouteRow = Schema.Struct({
  target_turn_id: Schema.String,
  kind: Schema.String,
  source_thread_id: Schema.NullOr(Schema.String),
  source_turn_id: Schema.NullOr(Schema.String),
  delivery: Schema.String,
  ready_sequence: Schema.NullOr(Schema.Finite),
  delivered_turn_id: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
})
