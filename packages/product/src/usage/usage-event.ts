import * as ExecutionEvent from "@rika/product/execution-event"
import * as ExecutionStatus from "../execution/contract/execution-status"
import { Schema } from "effect"

export interface RootExecution {
  readonly threadId: string
  readonly turnId: string
}

export interface DeliveryIdentity {
  readonly threadId: string
  readonly turnId: string
  readonly type: string
  readonly createdAt: number
  readonly sequence: number
  readonly data: string
}

type ActiveEventType =
  | "execution.accepted"
  | "execution.started"
  | "wait.created"
  | "wait.woken"
  | "wait.timed_out"
  | "wait.cancelled"
  | "execution.completed"
  | "execution.failed"
  | "execution.cancelled"

export interface ActiveEvent {
  readonly key: string
  readonly executionId: string
  readonly threadId: string
  readonly turnId: string
  readonly type: ActiveEventType
  readonly createdAt: number
  readonly sequence: number
}

type ProjectionFailureReason =
  | "missing-server-stamp"
  | "invalid-identity"
  | "invalid-timestamp"
  | "invalid-sequence"
  | "cursor-conflict"
  | "duplicate-sequence"
  | "timestamp-regression"
  | "invalid-transition"
  | "post-terminal"
  | "unsupported-version"
  | "decode-failure"

export class ProjectionFailure extends Schema.TaggedErrorClass<ProjectionFailure>()("UsageProjectionFailure", {
  message: Schema.String,
  reason: Schema.Literals([
    "missing-server-stamp",
    "invalid-identity",
    "invalid-timestamp",
    "invalid-sequence",
    "cursor-conflict",
    "duplicate-sequence",
    "timestamp-regression",
    "invalid-transition",
    "post-terminal",
    "unsupported-version",
    "decode-failure",
  ]),
  field: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  executionId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.String),
  sequence: Schema.optional(Schema.Finite),
}) {}

const lifecycleEventTypes = new Set<string>([
  "execution.accepted",
  "execution.started",
  "wait.created",
  "wait.woken",
  "wait.timed_out",
  "wait.cancelled",
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
])

const attemptEventTypes = new Set<string>(["model.usage.reported", "model.attempt.completed", "model.attempt.failed"])

export const isObservedEvent = (event: ExecutionEvent.Event): boolean =>
  lifecycleEventTypes.has(event.type) || attemptEventTypes.has(event.type)

export const isLifecycleEvent = (event: ExecutionEvent.Event): boolean => lifecycleEventTypes.has(event.type)

export const isServerStamped = (event: ExecutionEvent.Event): boolean => event.timestampSource === "server"

const isActiveEventType = (type: string): type is ActiveEventType => lifecycleEventTypes.has(type)

const isTerminalEventType = (type: ActiveEventType): boolean => ExecutionStatus.terminalEventStatus(type) !== undefined

const lifecycleFailure = (events: ReadonlyArray<ActiveEvent>): ProjectionFailureReason | undefined => {
  let accepted = false
  let started = false
  let terminal = false
  let outstandingWaits = 0
  for (const event of events) {
    if (terminal) return "post-terminal"
    if (event.type === "execution.accepted") {
      if (accepted || started) return "invalid-transition"
      accepted = true
      continue
    }
    if (event.type === "execution.started") {
      if (started) return "invalid-transition"
      started = true
      continue
    }
    if (event.type === "wait.created") {
      if (!started) return "invalid-transition"
      outstandingWaits += 1
      continue
    }
    if (event.type === "wait.woken" || event.type === "wait.timed_out" || event.type === "wait.cancelled") {
      if (!started || outstandingWaits === 0) return "invalid-transition"
      outstandingWaits -= 1
      continue
    }
    terminal = true
  }
  return undefined
}

export const Lifecycle = {
  isActiveEventType,
  isTerminalEventType,
  failure: lifecycleFailure,
}
