import { Schema } from "effect"

export const TurnRow = Schema.Struct({
  id: Schema.String,
  thread_id: Schema.String,
  prompt: Schema.String,
  status: Schema.String,
  last_cursor: Schema.NullOr(Schema.String),
  created_at: Schema.Finite,
  updated_at: Schema.Finite,
  extension_pin_json: Schema.NullOr(Schema.String),
  prompt_parts_json: Schema.NullOr(Schema.String),
  execution_route_json: Schema.NullOr(Schema.String),
  review_fan_out_id: Schema.NullOr(Schema.String),
  queue_claim_token: Schema.NullOr(Schema.String),
  author_json: Schema.String,
  lineage_json: Schema.String,
  stop_intent: Schema.String,
  turn_kind: Schema.String,
  shell_command: Schema.NullOr(Schema.String),
  shell_result_text: Schema.NullOr(Schema.String),
  shell_result_truncated: Schema.NullOr(Schema.Finite),
  shell_result_exit_code: Schema.NullOr(Schema.Finite),
})
