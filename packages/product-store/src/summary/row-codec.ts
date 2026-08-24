import { Schema } from "effect"


export const ThreadSummaryRow = Schema.Struct({
  id: Schema.String,
  workspace: Schema.String,
  title: Schema.String,
  pinned: Schema.Finite,
  archived: Schema.Finite,
  status_rank: Schema.Finite,
  last_status: Schema.NullOr(Schema.String),
  last_activity_at: Schema.Finite,
  last_read_at: Schema.NullOr(Schema.Finite),
  turn_count: Schema.Finite,
  current_activity_count: Schema.Finite,
  added: Schema.Finite,
  modified: Schema.Finite,
  removed: Schema.Finite,
})
