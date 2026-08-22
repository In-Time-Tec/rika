import { Schema } from "effect"
import { Input, OperationUnavailable } from "../contract/product-operation"
import { InteractiveCommand } from "./command"
import { InteractiveEventSchema } from "./event"

type InteractiveInput = Extract<Input, { readonly _tag: "Interactive" }>
const PositiveSequence = Schema.Int.check(Schema.isGreaterThan(0))
const InteractiveCommandRequest = Schema.Struct({
  _tag: Schema.tag("interactive-command"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  commandSequence: PositiveSequence,
  command: InteractiveCommand,
})
const CancelInteractiveCommand = Schema.Struct({
  _tag: Schema.tag("cancel-interactive-command"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  commandSequence: PositiveSequence,
})
const InteractiveFeedAck = Schema.Struct({
  _tag: Schema.tag("interactive-feed-ack"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  throughSequence: PositiveSequence,
})
const InteractiveEnd = Schema.Struct({
  _tag: Schema.tag("interactive-end"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
})
const InteractiveStarted = Schema.Struct({
  _tag: Schema.tag("interactive-started"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  feedCapacity: PositiveSequence,
})
const InteractiveFeedEvent = Schema.Struct({
  _tag: Schema.tag("interactive-feed-event"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  sequence: PositiveSequence,
  event: InteractiveEventSchema,
})
const InteractiveCommandCompleted = Schema.Struct({
  _tag: Schema.tag("interactive-command-completed"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  commandSequence: PositiveSequence,
})
const InteractiveCommandFailed = Schema.Struct({
  _tag: Schema.tag("interactive-command-failed"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  commandSequence: PositiveSequence,
  error: OperationUnavailable,
})

export { InteractiveFeedEvent }

export const InteractiveFeedProtocol = {
  InteractiveCommandRequest,
  CancelInteractiveCommand,
  InteractiveFeedAck,
  InteractiveEnd,
  InteractiveStarted,
  InteractiveFeedEvent,
  InteractiveCommandCompleted,
  InteractiveCommandFailed,
} as const
export type { InteractiveInput }
