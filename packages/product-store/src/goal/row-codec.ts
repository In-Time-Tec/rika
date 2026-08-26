import { Schema } from "effect"

export const GoalRow = Schema.Struct({
  thread_id: Schema.String,
  objective: Schema.String,
  status: Schema.String,
  budget_tokens: Schema.NullOr(Schema.Finite),
  budget_wall_clock_millis: Schema.NullOr(Schema.Finite),
  usage_tokens: Schema.Finite,
  usage_elapsed_millis: Schema.Finite,
  usage_turns: Schema.Finite,
  started_at: Schema.Finite,
  updated_at: Schema.Finite,
  completed_at: Schema.NullOr(Schema.Finite),
  summary: Schema.NullOr(Schema.String),
})
