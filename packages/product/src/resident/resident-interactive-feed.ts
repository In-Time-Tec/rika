import { Schema } from "effect"
import { InteractiveCommand } from "../operation/interactive/interactive-command"
import { InteractiveEventSchema } from "../operation/interactive/interactive-event"
import { Input } from "../operation/contract/product-operation"
import * as Overflow from "../operation/interactive/interactive-feed-overflow"
import { OperationUnavailable } from "../operation/contract/product-operation"

type InteractiveInput = Extract<Input, { readonly _tag: "Interactive" }>
const PositiveSequence = Schema.Int.check(Schema.isGreaterThan(0))
const NonNegativeSequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
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
const InteractiveFeedReplay = Schema.Struct({
  _tag: Schema.tag("interactive-feed-replay"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  afterSequence: NonNegativeSequence,
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
const InteractiveFeedResync = Schema.Struct({
  _tag: Schema.tag("interactive-feed-resync"),
  connectionId: Schema.String,
  requestId: Schema.String,
  sessionId: Schema.String,
  feedGeneration: Schema.String,
  sequence: PositiveSequence,
  events: Schema.Array(InteractiveEventSchema),
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

export { InteractiveFeedEvent, InteractiveFeedResync }

export const InteractiveFeedProtocol = {
  InteractiveCommandRequest,
  CancelInteractiveCommand,
  InteractiveFeedAck,
  InteractiveFeedReplay,
  InteractiveEnd,
  InteractiveStarted,
  InteractiveFeedEvent,
  InteractiveFeedResync,
  InteractiveCommandCompleted,
  InteractiveCommandFailed,
} as const
const make = Overflow.make
const remember = Overflow.remember
const events = Overflow.events
type State = Overflow.State

export { make, remember, events }
export type { InteractiveInput, State }
