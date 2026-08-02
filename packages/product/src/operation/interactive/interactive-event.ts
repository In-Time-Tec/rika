import * as Thread from "@rika/product/thread-record"
import * as ThreadSummary from "@rika/product/thread-summary"
import * as TranscriptPage from "@rika/product/transcript-page"
import * as Turn from "@rika/product/turn-record"
import { Schema } from "effect"
import * as IngestProjection from "../../execution/ingest/execution-projection-contract"
import * as IngestProjectionSchema from "../../execution/ingest/execution-projection-schema"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"

export interface QueueItem {
  readonly id: Turn.TurnId
  readonly prompt: string
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
      readonly _tag: "ThreadUsageUpdated"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly revision: number
      readonly context:
        | {
            readonly _tag: "Available"
            readonly inputTokens: number
            readonly contextWindow: number
            readonly reserveTokens: number
          }
        | { readonly _tag: "Unavailable" }
      readonly cost:
        | { readonly _tag: "Available"; readonly usd: number; readonly unpricedAttempts: number }
        | { readonly _tag: "Unavailable" }
      readonly tokens:
        | { readonly _tag: "Available"; readonly total: number; readonly uncountedAttempts: number }
        | { readonly _tag: "Unavailable" }
      readonly time:
        | {
            readonly _tag: "Available"
            readonly accumulatedMillis: number
            readonly activeSince?: number
          }
        | { readonly _tag: "Unavailable" }
    }
  | {
      readonly _tag: "ContextDiagnostics"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly messages: ReadonlyArray<string>
    }
  | {
      readonly _tag: "TitleCostUpdated"
      readonly threadId: Thread.ThreadId
      readonly turnId: Turn.TurnId
      readonly turnCostUsd: number
      readonly threadCostUsd: number
      readonly globalCostUsd: number
    }
  | {
      readonly _tag: "TranscriptProjectionStarted"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly rootTurnId: Turn.TurnId
      readonly turn: Turn.Turn
      readonly streamId: string
      readonly patchRevision: number
      readonly state: IngestProjection.VisibleState
      readonly units: ReadonlyArray<TranscriptUnit.Unit>
      readonly rootStatus?: IngestProjection.TerminalStatus
    }
  | {
      readonly _tag: "TranscriptProjectionPatched"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly rootTurnId: Turn.TurnId
      readonly turn?: Turn.Turn
      readonly streamId: string
      readonly baseRevision: number
      readonly patchRevision: number
      readonly origin: IngestProjection.ProjectionOrigin
      readonly state: IngestProjection.VisibleState
      readonly delta: IngestProjection.UnitDelta
      readonly rootStatus?: IngestProjection.TerminalStatus
    }
  | {
      readonly _tag: "TranscriptProjectionStopped"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly rootTurnId: Turn.TurnId
      readonly streamId: string
      readonly patchRevision: number
      readonly status: IngestProjection.TerminalStatus
    }
  | {
      readonly _tag: "TranscriptProjectionFailed"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly rootTurnId: Turn.TurnId
      readonly streamId: string
      readonly patchRevision: number
      readonly executionId: string
      readonly reason: string
      readonly message: string
    }
  | {
      readonly _tag: "TranscriptResyncRequired"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly reason: string
    }
  | {
      readonly _tag: "ThreadRefolding"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly refolding: boolean
    }
  | { readonly _tag: "AssistantCompleted"; readonly text: string }
  | {
      readonly _tag: "ExecutionFailed"
      readonly selectionEpoch: number
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly message: string
    }
  | {
      readonly _tag: "ExecutionControlFailed"
      readonly selectionEpoch: number
      readonly threadId?: Thread.ThreadId
      readonly turnId?: Turn.TurnId
      readonly action: "steer" | "cancel"
      readonly message: string
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
      readonly _tag: "QueueResyncRequired"
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
      readonly threadCostUsd?: number
      readonly globalCostUsd?: number
      readonly oldestCursor?: TranscriptPage.PageCursor
      readonly newestCursor?: TranscriptPage.PageCursor
      readonly queueRevision: number
      readonly queuedCount?: number
      readonly queue: ReadonlyArray<QueueItem>
      readonly activeTurn?: Turn.Turn
    }
  | {
      readonly _tag: "TranscriptPagePrepended"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly entries: ReadonlyArray<TranscriptPage.Entry>
      readonly hasOlder: boolean
      readonly threadCostUsd?: number
      readonly globalCostUsd?: number
      readonly oldestCursor?: TranscriptPage.PageCursor
    }
  | {
      readonly _tag: "TranscriptPageAppended"
      readonly selectionEpoch: number
      readonly threadId: Thread.ThreadId
      readonly entries: ReadonlyArray<TranscriptPage.Entry>
      readonly hasNewer: boolean
      readonly requestedAfter: TranscriptPage.PageCursor
      readonly threadCostUsd?: number
      readonly newestCursor?: TranscriptPage.PageCursor
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
  | { readonly _tag: "ThreadActivated"; readonly threadId: string; readonly title: string }
  | {
      readonly _tag: "ThreadPreviewLoaded"
      readonly threadId: string
      readonly turns: ReadonlyArray<{ readonly prompt: string; readonly units: ReadonlyArray<unknown> }>
    }

export const InteractiveEventSchema = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("ThreadUsageUpdated"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    revision: Schema.Int,
    context: Schema.Union([
      Schema.Struct({
        _tag: Schema.tag("Available"),
        inputTokens: Schema.Finite,
        contextWindow: Schema.Finite,
        reserveTokens: Schema.Finite,
      }),
      Schema.Struct({ _tag: Schema.tag("Unavailable") }),
    ]),
    cost: Schema.Union([
      Schema.Struct({ _tag: Schema.tag("Available"), usd: Schema.Finite, unpricedAttempts: Schema.Int }),
      Schema.Struct({ _tag: Schema.tag("Unavailable") }),
    ]),
    tokens: Schema.Union([
      Schema.Struct({ _tag: Schema.tag("Available"), total: Schema.Finite, uncountedAttempts: Schema.Int }),
      Schema.Struct({ _tag: Schema.tag("Unavailable") }),
    ]),
    time: Schema.Union([
      Schema.Struct({
        _tag: Schema.tag("Available"),
        accumulatedMillis: Schema.Finite,
        activeSince: Schema.optionalKey(Schema.Finite),
      }),
      Schema.Struct({ _tag: Schema.tag("Unavailable") }),
    ]),
  }),
  Schema.Struct({
    _tag: Schema.tag("ContextDiagnostics"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    messages: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    _tag: Schema.tag("TitleCostUpdated"),
    threadId: Thread.ThreadId,
    turnId: Turn.TurnId,
    turnCostUsd: Schema.Finite,
    threadCostUsd: Schema.Finite,
    globalCostUsd: Schema.Finite,
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptProjectionStarted"),
    selectionEpoch: Schema.Int,
    ...IngestProjectionSchema.SnapshotSchema.fields,
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptProjectionPatched"),
    selectionEpoch: Schema.Int,
    ...IngestProjectionSchema.PatchSchema.fields,
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptProjectionStopped"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    rootTurnId: Turn.TurnId,
    streamId: Schema.String,
    patchRevision: Schema.Int,
    status: IngestProjectionSchema.TerminalStatusSchema,
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptProjectionFailed"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    rootTurnId: Turn.TurnId,
    streamId: Schema.String,
    patchRevision: Schema.Int,
    executionId: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptResyncRequired"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    reason: Schema.String,
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
    message: Schema.String,
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
            attachments: Schema.optionalKey(Schema.Array(Schema.String)),
          }),
        ),
      }),
      Schema.Struct({
        _tag: Schema.tag("Added"),
        item: Schema.Struct({
          id: Turn.TurnId,
          prompt: Schema.String,
          attachments: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      }),
      Schema.Struct({
        _tag: Schema.tag("Updated"),
        item: Schema.Struct({
          id: Turn.TurnId,
          prompt: Schema.String,
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
    _tag: Schema.tag("QueueResyncRequired"),
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
    threadCostUsd: Schema.optionalKey(Schema.Finite),
    globalCostUsd: Schema.optionalKey(Schema.Finite),
    oldestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
    newestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
    queueRevision: Schema.Int,
    queuedCount: Schema.optionalKey(Schema.Int),
    queue: Schema.Array(
      Schema.Struct({
        id: Turn.TurnId,
        prompt: Schema.String,
        attachments: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
    activeTurn: Schema.optionalKey(Turn.Turn),
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptPagePrepended"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    entries: Schema.Array(TranscriptPage.EntrySchema),
    hasOlder: Schema.Boolean,
    threadCostUsd: Schema.optionalKey(Schema.Finite),
    globalCostUsd: Schema.optionalKey(Schema.Finite),
    oldestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
  }),
  Schema.Struct({
    _tag: Schema.tag("TranscriptPageAppended"),
    selectionEpoch: Schema.Int,
    threadId: Thread.ThreadId,
    entries: Schema.Array(TranscriptPage.EntrySchema),
    hasNewer: Schema.Boolean,
    requestedAfter: TranscriptPage.PageCursor,
    threadCostUsd: Schema.optionalKey(Schema.Finite),
    newestCursor: Schema.optionalKey(TranscriptPage.PageCursor),
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
    action: Schema.Literals(["steer", "cancel"]),
    message: Schema.String,
    steeringText: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ _tag: Schema.tag("ThreadTitled"), threadId: Schema.String, title: Schema.String }),
  Schema.Struct({ _tag: Schema.tag("ThreadActivated"), threadId: Schema.String, title: Schema.String }),
  Schema.Struct({
    _tag: Schema.tag("ThreadPreviewLoaded"),
    threadId: Schema.String,
    turns: Schema.Array(Schema.Struct({ prompt: Schema.String, units: Schema.Array(Schema.Unknown) })),
  }),
])
