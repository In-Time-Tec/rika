import * as Thread from "@rika/product/thread-record"
import * as ThreadSummary from "@rika/product/thread-summary"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as Turn from "@rika/product/turn-record"
import { Schema } from "effect"
import { Failure } from "../operation-failure"
import * as ExecutionProjection from "../../execution/contract/execution-projection"
import * as ExecutionGateway from "../../execution/contract/execution-gateway"

export interface QueueItem {
  readonly id: Turn.TurnId
  readonly prompt: string
  readonly createdAt: number
  readonly attachments?: ReadonlyArray<string>
}

export type QueueChange =
  | { readonly _tag: "Reset"; readonly items: ReadonlyArray<QueueItem> }
  | { readonly _tag: "Added"; readonly item: QueueItem }
  | { readonly _tag: "Updated"; readonly item: QueueItem }
  | { readonly _tag: "Removed"; readonly turnId: Turn.TurnId }

export type InteractiveEvent =
  | { readonly _tag: "ThreadsListed"; readonly threads: ReadonlyArray<ThreadSummary.ThreadSummary> }
  | {
      readonly _tag: "ContextDiagnostics"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly messages: ReadonlyArray<string>
    }
  | {
      readonly _tag: "ExecutionProjectionChanged"
      readonly threadId: Thread.ThreadId
      readonly turn?: Turn.Turn
      readonly change: ExecutionProjection.Change
    }
  | {
      readonly _tag: "ExecutionModelPreviewed"
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly preview: ExecutionGateway.ModelPreviewed
    }
  | {
      readonly _tag: "ExecutionProjectionResyncRequired"
      readonly threadId: Thread.ThreadId
    }
  | {
      readonly _tag: "ThreadRefolding"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly refolding: boolean
    }
  | { readonly _tag: "AssistantCompleted"; readonly text: string }
  | {
      readonly _tag: "TurnRetryScheduled"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly retryTurnId: Turn.TurnId
      readonly attempt: number
      readonly budget: number
      readonly message: string
      readonly nextAt: number
    }
  | {
      readonly _tag: "ExecutionFailed"
      readonly selectionEpoch: number
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly failure: Failure
    }
  | {
      readonly _tag: "ExecutionControlFailed"
      readonly selectionEpoch: number
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly action: "steer" | "cancel" | "approve" | "deny"
      readonly failure: Failure
      readonly steeringText?: string
    }
  | {
      readonly _tag: "QueueUpdated"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly revision: number
      readonly queuedCount: number
      readonly change: QueueChange
    }
  | {
      readonly _tag: "QueueFull"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly capacity: number
      readonly count: number
    }
  | {
      readonly _tag: "ThreadViewResyncRequired"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly reason: string
    }
  | {
      readonly _tag: "TurnStarted"
      readonly selectionEpoch: number
      readonly activitySequence: number
      readonly threadId: Thread.ThreadId
      readonly turn: Turn.Turn
      readonly submissionId?: string
    }
  | {
      readonly _tag: "TurnSettled"
      readonly selectionEpoch: number
      readonly activitySequence: number
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly status: "completed" | "failed" | "cancelled"
      readonly agentResponseArrived?: boolean
    }
  | {
      readonly _tag: "SubmissionAdmitted"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly status: "active" | "queued"
      readonly submissionId?: string
    }
  | {
      readonly _tag: "SelectionLoaded"
      readonly selectionEpoch: number
      readonly activitySequence: number
      readonly thread: Thread.Thread
      readonly entries: ReadonlyArray<TranscriptPage.Entry>
      readonly hasOlder: boolean
      readonly hasNewer?: boolean
      readonly usage: TranscriptPage.UsageSummary
      readonly oldestCursor?: TranscriptPage.PageCursor
      readonly newestCursor?: TranscriptPage.PageCursor
      readonly queueRevision: number
      readonly queuedCount?: number
      readonly queue: ReadonlyArray<QueueItem>
      readonly activeTurn?: Turn.Turn
    }
  | {
      readonly _tag: "ShellCompleted"
      readonly threadId: Thread.ThreadId
      readonly command: string
      readonly text: string
      readonly incognito: boolean
      readonly status: "completed" | "failed" | "cancelled"
    }
  | {
      readonly _tag: "ExecutionControlled"
      readonly selectionEpoch: number
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly action: "steered" | "cancelled"
      readonly agentResponseArrived?: boolean
      readonly steeringSequence?: number
      readonly steeringText?: string
    }
  | { readonly _tag: "ThreadTitled"; readonly threadId: string; readonly title: string }
  | {
      readonly _tag: "GoalChanged"
      readonly threadId: string
      readonly goal?: {
        readonly objective: string
        readonly status: "active" | "paused" | "complete" | "errored"
        readonly startedAtMillis: number
      }
    }
  | { readonly _tag: "ThreadActivated"; readonly threadId: string; readonly title: string }
  | {
      readonly _tag: "ThreadPreviewLoaded"
      readonly threadId: string
      readonly turns: ReadonlyArray<{ readonly prompt: string; readonly units: ReadonlyArray<unknown> }>
    }
  | { readonly _tag: "ThreadPreviewFailed"; readonly threadId: string; readonly message: string }

export const InteractiveEventSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("ContextDiagnostics"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    messages: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionProjectionChanged"),
    threadId: Thread.ThreadId,
    turn: Schema.optionalKey(Turn.Turn),
    change: ExecutionProjection.Change,
  }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionModelPreviewed"),
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    preview: ExecutionGateway.ModelPreviewed,
  }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionProjectionResyncRequired"),
    threadId: Thread.ThreadId,
  }),
  Schema.Struct({
    _tag: Schema.tag("ThreadRefolding"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    refolding: Schema.Boolean,
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadsListed"), threads: Schema.Array(ThreadSummary.ThreadSummary) }),
  Schema.Struct({ _tag: Schema.tag("AssistantCompleted"), text: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionFailed"),
    selectionEpoch: Schema.Int,
    threadId: Schema.optionalKey(Thread.ThreadId),
    turnId: Schema.optionalKey(Turn.TurnId),
    failure: Failure,
  }),
  Schema.Struct({
    _tag: Schema.tag("QueueUpdated"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    revision: Schema.Int,
    queuedCount: Schema.Int,
    change: Schema.Union([
      Schema.Struct({
        _tag: Schema.tag("Reset"),
        items: Schema.Array(
          Schema.Struct({
            id: Turn.TurnId,
            prompt: Schema.String,
            createdAt: Schema.Finite,
            attachments: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      }),
      Schema.Struct({
        _tag: Schema.tag("Added"),
        item: Schema.Struct({
          id: Turn.TurnId,
          prompt: Schema.String,
          createdAt: Schema.Finite,
          attachments: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      }),
      Schema.Struct({
        _tag: Schema.tag("Updated"),
        item: Schema.Struct({
          id: Turn.TurnId,
          prompt: Schema.String,
          createdAt: Schema.Finite,
          attachments: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      }),
      Schema.Struct({ _tag: Schema.tag("Removed"), turnId: Turn.TurnId }),
    ]),
  }),
  Schema.Struct({
    _tag: Schema.tag("QueueFull"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    capacity: Schema.Int,
    count: Schema.Int,
  }),
  Schema.Struct({
    _tag: Schema.tag("ThreadViewResyncRequired"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    reason: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("TurnStarted"),
    selectionEpoch: Schema.Int,
    activitySequence: Schema.Int,
    threadId: Thread.ThreadId,
    turn: Turn.Turn,
    submissionId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("TurnSettled"),
    selectionEpoch: Schema.Int,
    activitySequence: Schema.Int,
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    status: Schema.Literals(["completed", "failed", "cancelled"]),
    agentResponseArrived: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    _tag: Schema.tag("SubmissionAdmitted"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    status: Schema.Literals(["active", "queued"]),
    submissionId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("SelectionLoaded"),
    selectionEpoch: Schema.Int,
    activitySequence: Schema.Int,
    thread: Thread.Thread,
    entries: Schema.Array(TranscriptPage.EntrySchema),
    hasOlder: Schema.Boolean,
    hasNewer: Schema.optionalKey(Schema.Boolean),
    usage: TranscriptPage.UsageSummary,
    oldestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
    newestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
    queueRevision: Schema.Int,
    queuedCount: Schema.optionalKey(Schema.Int),
    queue: Schema.Array(
      Schema.Struct({
        id: Turn.TurnId,
        prompt: Schema.String,
        createdAt: Schema.Finite,
        attachments: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
    activeTurn: Schema.optionalKey(Turn.Turn),
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
    selectionEpoch: Schema.Int,
    threadId: Schema.optionalKey(Thread.ThreadId),
    turnId: Schema.optionalKey(Turn.TurnId),
    action: Schema.Literals(["steered", "cancelled"]),
    agentResponseArrived: Schema.optionalKey(Schema.Boolean),
    steeringSequence: Schema.optionalKey(Schema.Int),
    steeringText: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("ExecutionControlFailed"),
    selectionEpoch: Schema.Int,
    threadId: Schema.optionalKey(Thread.ThreadId),
    turnId: Schema.optionalKey(Turn.TurnId),
    action: Schema.Literals(["steer", "cancel", "approve", "deny"]),
    failure: Failure,
    steeringText: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadTitled"), threadId: Schema.String, title: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("GoalChanged"),
    threadId: Schema.String,
    goal: Schema.optionalKey(
      Schema.Struct({
        objective: Schema.String,
        status: Schema.Literals(["active", "paused", "complete", "errored"]),
        startedAtMillis: Schema.Finite,
      }),
    ),
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadActivated"), threadId: Schema.String, title: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ThreadPreviewLoaded"),
    threadId: Schema.String,
    turns: Schema.Array(Schema.Struct({ prompt: Schema.String, units: Schema.Array(Schema.Unknown) })),
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadPreviewFailed"), threadId: Schema.String, message: Schema.String }),
])
