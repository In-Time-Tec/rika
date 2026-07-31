import { Schema } from "effect"
import type { Status } from "./execution-status"

export const Event = Schema.Struct({
  executionId: Schema.String,
  childExecutionId: Schema.optionalKey(Schema.String),
  cursor: Schema.String,
  sequence: Schema.Finite,
  type: Schema.String,
  createdAt: Schema.Finite,
  timestampSource: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type Event = typeof Event.Type

export interface ExecutionCheckpoint {
  readonly cursor: string
  readonly sequence: number
}

export interface Result {
  readonly turnId: string
  readonly status: Status
  readonly events: ReadonlyArray<Event>
  readonly checkpoint?: ExecutionCheckpoint
}

export interface EventPage {
  readonly events: ReadonlyArray<Event>
  readonly hasMore: boolean
  readonly oldestCursor?: string
  readonly newestCursor?: string
}
