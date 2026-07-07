import { Effect, Schema } from "effect"
import { Artifact } from "./artifact"
import { JsonValue, Metadata, ProtocolVersion, TimestampMillis } from "./common"
import { Envelope } from "./error"
import { ArtifactId, EventId, MessageId, ThreadId, ToolCallId, TurnId, UserId, WorkspaceId } from "./ids"
import { Message } from "./message"
import { Call, Result, TurnToolAccess } from "./tool"

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
    title_text: Schema.optional(Schema.String),
    forked_from: Schema.optional(
      Schema.Struct({
        thread_id: ThreadId,
        sequence: Schema.Int,
      }),
    ),
  }),
}).annotate({ identifier: "Rika.Event.ThreadCreated" })

export const ThreadVisibility = Schema.Literals(["private", "workspace", "unlisted"]).annotate({
  identifier: "Rika.Event.ThreadVisibility",
})
export type ThreadVisibility = typeof ThreadVisibility.Type

export const ThreadVisibilityDefaulted = ThreadVisibility.pipe(
  Schema.optional,
  Schema.withDecodingDefault(Effect.succeed("private" as const)),
).annotate({ identifier: "Rika.Event.ThreadVisibilityDefaulted" })

export interface TurnStarted extends Schema.Schema.Type<typeof TurnStarted> {}
export const TurnMode = Schema.Literals(["rush", "smart", "deep1", "deep2", "deep3"]).annotate({
  identifier: "Rika.Event.TurnMode",
})
export type TurnMode = typeof TurnMode.Type

export const TurnStarted = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("turn.started"),
  data: Schema.Struct({
    user_id: Schema.optional(UserId),
    mode: Schema.optional(TurnMode),
    tool_access: Schema.optional(TurnToolAccess),
  }),
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

export interface ModelReasoningDelta extends Schema.Schema.Type<typeof ModelReasoningDelta> {}
export const ModelReasoningDelta = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("model.reasoning.delta"),
  data: Schema.Struct({
    text: Schema.String,
    provider: Schema.String,
    model: Schema.String,
  }),
}).annotate({ identifier: "Rika.Event.ModelReasoningDelta" })

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

export const ContextCompactionTrigger = Schema.Literals(["manual", "auto", "overflow"]).annotate({
  identifier: "Rika.Event.ContextCompactionTrigger",
})
export type ContextCompactionTrigger = typeof ContextCompactionTrigger.Type

export interface ContextCompacted extends Schema.Schema.Type<typeof ContextCompacted> {}
export const ContextCompacted = Schema.Struct({
  ...fields,
  type: Schema.Literal("context.compacted"),
  data: Schema.Struct({
    summary: Schema.String,
    tail_start_sequence: Schema.Int,
    trigger: ContextCompactionTrigger,
    tokens_before: Schema.optional(Schema.Int),
    model: Schema.String,
  }),
}).annotate({ identifier: "Rika.Event.ContextCompacted" })

export interface ContextPruned extends Schema.Schema.Type<typeof ContextPruned> {}
export const ContextPruned = Schema.Struct({
  ...fields,
  type: Schema.Literal("context.pruned"),
  data: Schema.Struct({
    tool_call_ids: Schema.Array(ToolCallId),
    estimated_tokens_freed: Schema.Int,
  }),
}).annotate({ identifier: "Rika.Event.ContextPruned" })

export interface SkillLoaded extends Schema.Schema.Type<typeof SkillLoaded> {}
export const SkillLoaded = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("skill.loaded"),
  data: Schema.Struct({
    name: Schema.String,
    description: Schema.String,
    source: Schema.String,
    skill_file: Schema.String,
    resource_paths: Schema.Array(Schema.String),
  }),
}).annotate({ identifier: "Rika.Event.SkillLoaded" })

export interface SubagentCompleted extends Schema.Schema.Type<typeof SubagentCompleted> {}
export const SubagentCompleted = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("subagent.completed"),
  data: Schema.Struct({
    subagent_id: Schema.String,
    name: Schema.String,
    status: Schema.Literals(["completed", "failed", "cancelled"]),
    summary: Schema.String,
    evidence: Schema.Array(Schema.String),
    tool_access: Schema.Literals(["read-only", "read-write", "none"]),
    tool_names: Schema.Array(Schema.String),
    started_at: TimestampMillis,
    completed_at: TimestampMillis,
  }),
}).annotate({ identifier: "Rika.Event.SubagentCompleted" })

export interface ToolCallRequested extends Schema.Schema.Type<typeof ToolCallRequested> {}
export const ToolCallRequested = Schema.Struct({
  ...fields,
  type: Schema.Literal("tool.call.requested"),
  data: Schema.Struct({ call: Call }),
}).annotate({ identifier: "Rika.Event.ToolCallRequested" })

export interface ToolCallInputStarted extends Schema.Schema.Type<typeof ToolCallInputStarted> {}
export const ToolCallInputStarted = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("tool.call.input.started"),
  data: Schema.Struct({
    id: ToolCallId,
    name: Schema.String,
  }),
}).annotate({ identifier: "Rika.Event.ToolCallInputStarted" })

export interface ToolCallInputDelta extends Schema.Schema.Type<typeof ToolCallInputDelta> {}
export const ToolCallInputDelta = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("tool.call.input.delta"),
  data: Schema.Struct({
    id: ToolCallId,
    text: Schema.String,
  }),
}).annotate({ identifier: "Rika.Event.ToolCallInputDelta" })

export interface ToolCallInputEnded extends Schema.Schema.Type<typeof ToolCallInputEnded> {}
export const ToolCallInputEnded = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("tool.call.input.ended"),
  data: Schema.Struct({
    id: ToolCallId,
    name: Schema.String,
    input_text: Schema.String,
  }),
}).annotate({ identifier: "Rika.Event.ToolCallInputEnded" })

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

export interface TokenUsage extends Schema.Schema.Type<typeof TokenUsage> {}
export const TokenUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Int),
  output_tokens: Schema.optional(Schema.Int),
  total_tokens: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Event.TokenUsage" })

export interface TurnCompleted extends Schema.Schema.Type<typeof TurnCompleted> {}
export const TurnCompleted = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("turn.completed"),
  data: Schema.Struct({
    provider: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    usage: Schema.optional(TokenUsage),
  }),
}).annotate({ identifier: "Rika.Event.TurnCompleted" })

export interface TurnFailed extends Schema.Schema.Type<typeof TurnFailed> {}
export const TurnFailed = Schema.Struct({
  ...fields,
  turn_id: TurnId,
  type: Schema.Literal("turn.failed"),
  data: Schema.Struct({ error: Envelope }),
}).annotate({ identifier: "Rika.Event.TurnFailed" })

export type TurnTerminal = TurnCompleted | TurnFailed
export const TurnTerminal = Schema.Union([TurnCompleted, TurnFailed]).pipe(
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "Rika.Event.TurnTerminal" }),
)

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

export interface ThreadVisibilitySet extends Schema.Schema.Type<typeof ThreadVisibilitySet> {}
export const ThreadVisibilitySet = Schema.Struct({
  ...fields,
  type: Schema.Literal("thread.visibility.set"),
  data: Schema.Struct({ visibility: ThreadVisibility }),
}).annotate({ identifier: "Rika.Event.ThreadVisibilitySet" })

export type Event =
  | ThreadCreated
  | TurnStarted
  | MessageAdded
  | ModelStreamChunk
  | ModelReasoningDelta
  | ContextResolved
  | ContextCompacted
  | ContextPruned
  | SkillLoaded
  | SubagentCompleted
  | ToolCallInputStarted
  | ToolCallInputDelta
  | ToolCallInputEnded
  | ToolCallRequested
  | ToolCallCompleted
  | ArtifactCreated
  | TurnCompleted
  | TurnFailed
  | ThreadArchived
  | ThreadUnarchived
  | ThreadVisibilitySet

export const Event = Schema.Union([
  ThreadCreated,
  TurnStarted,
  MessageAdded,
  ModelStreamChunk,
  ModelReasoningDelta,
  ContextResolved,
  ContextCompacted,
  ContextPruned,
  SkillLoaded,
  SubagentCompleted,
  ToolCallInputStarted,
  ToolCallInputDelta,
  ToolCallInputEnded,
  ToolCallRequested,
  ToolCallCompleted,
  ArtifactCreated,
  TurnCompleted,
  TurnFailed,
  ThreadArchived,
  ThreadUnarchived,
  ThreadVisibilitySet,
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
    case "tool.call.input.started":
    case "tool.call.input.delta":
    case "tool.call.input.ended":
      return { tool_call_id: event.data.id }
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
