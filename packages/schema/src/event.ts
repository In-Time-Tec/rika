import { Schema } from "effect"
import { Artifact } from "./artifact"
import { JsonValue, Metadata, ProtocolVersion, TimestampMillis } from "./common"
import { Envelope } from "./error"
import { ArtifactId, EventId, MessageId, ThreadId, ToolCallId, TurnId, UserId, WorkspaceId } from "./ids"
import { Message } from "./message"
import { Call, Result } from "./tool"

const fields = {
  id: EventId,
  thread_id: ThreadId,
  turn_id: Schema.optional(TurnId),
  sequence: Schema.Int,
  version: ProtocolVersion,
  created_at: TimestampMillis,
  metadata: Schema.optional(Metadata),
}

export interface ThreadCreated extends Schema.Schema.Type<typeof ThreadCreated> {}
export const ThreadCreated = Schema.Struct({
  ...fields,
  type: Schema.Literal("thread.created"),
  data: Schema.Struct({
    workspace_id: WorkspaceId,
    user_id: Schema.optional(UserId),
  }),
}).annotate({ identifier: "Rika.Event.ThreadCreated" })

export interface TurnStarted extends Schema.Schema.Type<typeof TurnStarted> {}
export const TurnStarted = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("turn.started"),
  data: Schema.Struct({}),
}).annotate({ identifier: "Rika.Event.TurnStarted" })

export interface MessageAdded extends Schema.Schema.Type<typeof MessageAdded> {}
export const MessageAdded = Schema.Struct({
  ...fields,
  type: Schema.Literal("message.added"),
  data: Schema.Struct({ message: Message }),
}).annotate({ identifier: "Rika.Event.MessageAdded" })

export interface ModelStreamChunk extends Schema.Schema.Type<typeof ModelStreamChunk> {}
export const ModelStreamChunk = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("model.stream.chunk"),
  data: Schema.Struct({
    text: Schema.String,
    provider: Schema.String,
    model: Schema.String,
  }),
}).annotate({ identifier: "Rika.Event.ModelStreamChunk" })

export const ContextEntryKind = Schema.Literals(["guidance", "file", "image", "thread-reference"]).annotate({
  identifier: "Rika.Event.ContextEntryKind",
})
export type ContextEntryKind = typeof ContextEntryKind.Type

export interface ContextEntry extends Schema.Schema.Type<typeof ContextEntry> {}
export const ContextEntry = Schema.Struct({
  kind: ContextEntryKind,
  source: Schema.String,
  reason: Schema.String,
  trusted: Schema.Boolean,
  path: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  media_type: Schema.optional(Schema.String),
  thread_reference: Schema.optional(Schema.String),
  truncated: Schema.optional(Schema.Boolean),
  metadata: Schema.optional(Metadata),
}).annotate({ identifier: "Rika.Event.ContextEntry" })

export interface ContextResolved extends Schema.Schema.Type<typeof ContextResolved> {}
export const ContextResolved = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("context.resolved"),
  data: Schema.Struct({
    entries: Schema.Array(ContextEntry),
    rendered: Schema.String,
    total_chars: Schema.Int,
    metadata: Schema.optional(JsonValue),
  }),
}).annotate({ identifier: "Rika.Event.ContextResolved" })

export interface ToolCallRequested extends Schema.Schema.Type<typeof ToolCallRequested> {}
export const ToolCallRequested = Schema.Struct({
  ...fields,
  type: Schema.Literal("tool.call.requested"),
  data: Schema.Struct({ call: Call }),
}).annotate({ identifier: "Rika.Event.ToolCallRequested" })

export interface ToolCallCompleted extends Schema.Schema.Type<typeof ToolCallCompleted> {}
export const ToolCallCompleted = Schema.Struct({
  ...fields,
  type: Schema.Literal("tool.call.completed"),
  data: Schema.Struct({ result: Result }),
}).annotate({ identifier: "Rika.Event.ToolCallCompleted" })

export interface ArtifactCreated extends Schema.Schema.Type<typeof ArtifactCreated> {}
export const ArtifactCreated = Schema.Struct({
  ...fields,
  type: Schema.Literal("artifact.created"),
  data: Schema.Struct({ artifact: Artifact }),
}).annotate({ identifier: "Rika.Event.ArtifactCreated" })

export interface TurnCompleted extends Schema.Schema.Type<typeof TurnCompleted> {}
export const TurnCompleted = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("turn.completed"),
  data: Schema.Struct({}),
}).annotate({ identifier: "Rika.Event.TurnCompleted" })

export interface TurnFailed extends Schema.Schema.Type<typeof TurnFailed> {}
export const TurnFailed = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("turn.failed"),
  data: Schema.Struct({ error: Envelope }),
}).annotate({ identifier: "Rika.Event.TurnFailed" })

export interface ThreadArchived extends Schema.Schema.Type<typeof ThreadArchived> {}
export const ThreadArchived = Schema.Struct({
  ...fields,
  type: Schema.Literal("thread.archived"),
  data: Schema.Struct({}),
}).annotate({ identifier: "Rika.Event.ThreadArchived" })

export interface ThreadUnarchived extends Schema.Schema.Type<typeof ThreadUnarchived> {}
export const ThreadUnarchived = Schema.Struct({
  ...fields,
  type: Schema.Literal("thread.unarchived"),
  data: Schema.Struct({}),
}).annotate({ identifier: "Rika.Event.ThreadUnarchived" })

export type Event =
  | ThreadCreated
  | TurnStarted
  | MessageAdded
  | ModelStreamChunk
  | ContextResolved
  | ToolCallRequested
  | ToolCallCompleted
  | ArtifactCreated
  | TurnCompleted
  | TurnFailed
  | ThreadArchived
  | ThreadUnarchived

export const Event = Schema.Union([
  ThreadCreated,
  TurnStarted,
  MessageAdded,
  ModelStreamChunk,
  ContextResolved,
  ToolCallRequested,
  ToolCallCompleted,
  ArtifactCreated,
  TurnCompleted,
  TurnFailed,
  ThreadArchived,
  ThreadUnarchived,
]).pipe(Schema.toTaggedUnion("type"), Schema.annotate({ identifier: "Rika.Event" }))

export interface References {
  readonly message_id?: MessageId
  readonly tool_call_id?: ToolCallId
  readonly artifact_id?: ArtifactId
}

export const references = (event: Event): References => {
  switch (event.type) {
    case "message.added":
      return { message_id: event.data.message.id }
    case "tool.call.requested":
      return { tool_call_id: event.data.call.id }
    case "tool.call.completed":
      return { tool_call_id: event.data.result.id }
    case "artifact.created":
      return { artifact_id: event.data.artifact.id }
    default:
      return {}
  }
}
