import { Schema } from "effect"
import { Kind as ArtifactKind } from "./artifact"
import { JsonValue, TimestampMillis } from "./common"
import { Event } from "./event"
import { ArtifactId, ThreadId, TurnId, UserId, WorkspaceId } from "./ids"

export const AgentMode = Schema.Literals(["rush", "smart", "deep"]).annotate({
  identifier: "Rika.Remote.AgentMode",
})
export type AgentMode = typeof AgentMode.Type

export const TurnStatus = Schema.Literals(["active", "completed", "failed"]).annotate({
  identifier: "Rika.Remote.TurnStatus",
})
export type TurnStatus = typeof TurnStatus.Type

export interface ThreadSummary extends Schema.Schema.Type<typeof ThreadSummary> {}
export const ThreadSummary = Schema.Struct({
  thread_id: ThreadId,
  workspace_id: WorkspaceId,
  user_id: Schema.optional(UserId),
  latest_message_text: Schema.optional(Schema.String),
  active_turn_id: Schema.optional(TurnId),
  active_turn_status: Schema.optional(TurnStatus),
  archived: Schema.Boolean,
  created_at: TimestampMillis,
  updated_at: TimestampMillis,
}).annotate({ identifier: "Rika.Remote.ThreadSummary" })

export interface ThreadRecord extends Schema.Schema.Type<typeof ThreadRecord> {}
export const ThreadRecord = Schema.Struct({
  summary: ThreadSummary,
  events: Schema.Array(Event),
}).annotate({ identifier: "Rika.Remote.ThreadRecord" })

export interface CreateThreadRequest extends Schema.Schema.Type<typeof CreateThreadRequest> {}
export const CreateThreadRequest = Schema.Struct({
  thread_id: Schema.optional(ThreadId),
  workspace_id: Schema.optional(WorkspaceId),
  user_id: Schema.optional(UserId),
}).annotate({ identifier: "Rika.Remote.CreateThreadRequest" })

export interface ListThreadsRequest extends Schema.Schema.Type<typeof ListThreadsRequest> {}
export const ListThreadsRequest = Schema.Struct({
  include_archived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Remote.ListThreadsRequest" })

export interface StartTurnRequest extends Schema.Schema.Type<typeof StartTurnRequest> {}
export const StartTurnRequest = Schema.Struct({
  thread_id: ThreadId,
  workspace_id: Schema.optional(WorkspaceId),
  user_id: Schema.optional(UserId),
  content: Schema.String,
  mode: Schema.optional(AgentMode),
  cancelled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Rika.Remote.StartTurnRequest" })

export interface InterruptTurnRequest extends Schema.Schema.Type<typeof InterruptTurnRequest> {}
export const InterruptTurnRequest = Schema.Struct({
  thread_id: ThreadId,
  turn_id: TurnId,
  reason: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Remote.InterruptTurnRequest" })

export interface ListArtifactsRequest extends Schema.Schema.Type<typeof ListArtifactsRequest> {}
export const ListArtifactsRequest = Schema.Struct({
  thread_id: ThreadId,
  kind: Schema.optional(ArtifactKind),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Remote.ListArtifactsRequest" })

export interface GetArtifactRequest extends Schema.Schema.Type<typeof GetArtifactRequest> {}
export const GetArtifactRequest = Schema.Struct({
  artifact_id: ArtifactId,
}).annotate({ identifier: "Rika.Remote.GetArtifactRequest" })

export interface ApiError extends Schema.Schema.Type<typeof ApiError> {}
export const ApiError = Schema.Struct({
  error: Schema.Struct({
    message: Schema.String,
    code: Schema.String,
    details: Schema.optional(JsonValue),
  }),
}).annotate({ identifier: "Rika.Remote.ApiError" })

export const StreamFrame = Schema.Union([Event, ApiError]).annotate({
  identifier: "Rika.Remote.StreamFrame",
})
export type StreamFrame = typeof StreamFrame.Type
