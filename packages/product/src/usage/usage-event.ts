import type * as ExecutionBackend from "@rika/product/execution-service"
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
  "execution.completed",
  "execution.failed",
  "execution.cancelled",
])

const attemptEventTypes = new Set<string>(["model.usage.reported", "model.attempt.completed", "model.attempt.failed"])

export const isObservedEvent = (event: ExecutionBackend.Event): boolean =>
  lifecycleEventTypes.has(event.type) || attemptEventTypes.has(event.type)

export const isLifecycleEvent = (event: ExecutionBackend.Event): boolean => lifecycleEventTypes.has(event.type)

export const isServerStamped = (event: ExecutionBackend.Event): boolean => event.timestampSource === "server"

const isActiveEventType = (type: string): type is ActiveEventType => lifecycleEventTypes.has(type)

const isTerminalEventType = (type: ActiveEventType): boolean => ExecutionStatus.terminalEventStatus(type) !== undefined

const lifecycleFailure = (events: ReadonlyArray<ActiveEvent>): ProjectionFailureReason | undefined => {
  let state: "initial" | "accepted" | "active" | "waiting" | "terminal" = "initial"
  for (const event of events) {
    if (state === "terminal") return "post-terminal"
    if (event.type === "execution.accepted") {
      if (state !== "initial") return "invalid-transition"
      state = "accepted"
    } else if (event.type === "execution.started") {
      if (state !== "initial" && state !== "accepted" && state !== "waiting") return "invalid-transition"
      state = "active"
    } else if (event.type === "wait.created") {
      if (state !== "active") return "invalid-transition"
      state = "waiting"
    } else if (event.type === "wait.woken" || event.type === "wait.timed_out") {
      if (state !== "waiting") return "invalid-transition"
      state = "active"
    } else {
      state = "terminal"
    }
  }
  return undefined
}

export const Lifecycle = {
  isActiveEventType,
  isTerminalEventType,
  failure: lifecycleFailure,
}
