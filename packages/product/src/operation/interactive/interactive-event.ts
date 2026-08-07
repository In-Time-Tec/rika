import * as Thread from "@rika/product/thread-record"
import * as ThreadSummary from "@rika/product/thread-summary"
import * as ThreadView from "@rika/product/thread-view"
import * as Turn from "@rika/product/turn-record"
import { Schema } from "effect"
import { Failure } from "../operation-failure"

export const InteractiveEventSchema = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("ThreadViewSnapshot"), snapshot: ThreadView.ThreadViewSnapshot }),
  Schema.Struct({ _tag: Schema.tag("ThreadViewPatch"), patch: ThreadView.ThreadViewPatch }),
  ThreadView.ResyncRequired,
  Schema.Struct({ _tag: Schema.tag("ThreadsListed"), threads: Schema.Array(ThreadSummary.ThreadSummary) }),
  Schema.Struct({
    _tag: Schema.tag("ContextDiagnostics"),
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    messages: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("ThreadRefolding"),
    threadId: Thread.ThreadId,
    refolding: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.tag("AssistantCompleted"), text: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionFailed"),
    threadId: Schema.optionalKey(Thread.ThreadId),
    turnId: Schema.optionalKey(Turn.TurnId),
    failure: Failure,
  }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionControlFailed"),
    threadId: Schema.optionalKey(Thread.ThreadId),
    turnId: Schema.optionalKey(Turn.TurnId),
    action: Schema.Literals(["steer", "cancel", "approve", "deny"]),
    failure: Failure,
    steeringText: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("QueueFull"),
    threadId: Thread.ThreadId,
    capacity: Schema.Int,
    count: Schema.Int,
  }),
  Schema.Struct({
    _tag: Schema.tag("SubmissionAdmitted"),
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    status: Schema.Literals(["active", "queued"]),
    submissionId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("ShellCompleted"),
    threadId: Thread.ThreadId,
    command: Schema.String,
    text: Schema.String,
    incognito: Schema.Boolean,
    status: Schema.Literals(["completed", "failed", "cancelled"]),
  }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionControlled"),
    threadId: Schema.optionalKey(Thread.ThreadId),
    turnId: Schema.optionalKey(Turn.TurnId),
    action: Schema.Literals(["steered", "cancelled"]),
    agentResponseArrived: Schema.optionalKey(Schema.Boolean),
    steeringSequence: Schema.optionalKey(Schema.Int),
    steeringText: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadTitled"), threadId: Schema.String, title: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("ThreadActivated"), threadId: Schema.String, title: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ThreadPreviewLoaded"),
    threadId: Schema.String,
    turns: Schema.Array(Schema.Struct({ prompt: Schema.String, units: Schema.Array(Schema.Unknown) })),
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadPreviewFailed"), threadId: Schema.String, message: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("TurnRetryScheduled"),
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    retryTurnId: Turn.TurnId,
    attempt: Schema.Int,
    budget: Schema.Int,
    message: Schema.String,
    nextAt: Schema.Finite,
  }),
])
export type InteractiveEvent = typeof InteractiveEventSchema.Type
