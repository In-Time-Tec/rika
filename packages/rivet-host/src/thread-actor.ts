import { Action, Actor } from "@rivetkit/effect"
import { AgentLoop, WorkspaceAccess } from "@rika/agent"
import { Database, ThreadEventLog, ThreadProjection, WorkspaceStore } from "@rika/persistence"
import { Event, Ids, Message } from "@rika/schema"
import { Schema } from "effect"

export const TurnStatus = Schema.Literals(["idle", "active", "completed", "failed"]).annotate({
  identifier: "Rika.RivetHost.ThreadActor.TurnStatus",
})
export type TurnStatus = typeof TurnStatus.Type

export interface ThreadActorSnapshot extends Schema.Schema.Type<typeof ThreadActorSnapshot> {}
export const ThreadActorSnapshot = Schema.Struct({
  thread_id: Ids.ThreadId,
  last_sequence: Schema.Int,
  message_count: Schema.Int,
  archived: Schema.Boolean,
  active_turn_id: Schema.optional(Ids.TurnId),
  active_turn_status: TurnStatus,
  latest_message_id: Schema.optional(Ids.MessageId),
  latest_message_role: Schema.optional(Message.Role),
  latest_message_text: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.Snapshot" })

export interface ThreadActorState extends Schema.Schema.Type<typeof ThreadActorState> {}
export const ThreadActorState = Schema.Struct({
  thread_id: Schema.optional(Ids.ThreadId),
  last_sequence: Schema.Int,
  message_count: Schema.Int,
  archived: Schema.Boolean,
  active_turn_id: Schema.optional(Ids.TurnId),
  active_turn_status: TurnStatus,
  latest_message_id: Schema.optional(Ids.MessageId),
  latest_message_role: Schema.optional(Message.Role),
  latest_message_text: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.State" })

export interface VerifiedUserIdentity extends Schema.Schema.Type<typeof VerifiedUserIdentity> {}
export const VerifiedUserIdentity = Schema.Struct({
  _tag: Schema.Literal("VerifiedUserIdentity"),
  user_id: Ids.UserId,
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.VerifiedUserIdentity" })

export interface EnsureThreadPayload extends Schema.Schema.Type<typeof EnsureThreadPayload> {}
export const EnsureThreadPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  workspace_id: Ids.WorkspaceId,
  identity: Schema.optional(VerifiedUserIdentity),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.EnsureThreadPayload" })

export interface AcceptTurnPayload extends Schema.Schema.Type<typeof AcceptTurnPayload> {}
export const AcceptTurnPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  workspace_id: Ids.WorkspaceId,
  identity: Schema.optional(VerifiedUserIdentity),
  content: Schema.String,
  content_parts: Schema.optional(Schema.Array(Message.ContentPart)),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.AcceptTurnPayload" })

export interface ThreadIdPayload extends Schema.Schema.Type<typeof ThreadIdPayload> {}
export const ThreadIdPayload = Schema.Struct({
  thread_id: Ids.ThreadId,
  identity: Schema.optional(VerifiedUserIdentity),
}).annotate({ identifier: "Rika.RivetHost.ThreadActor.ThreadIdPayload" })

export class ThreadActorActionError extends Schema.TaggedErrorClass<ThreadActorActionError>()(
  "ThreadActorActionError",
  {
    message: Schema.String,
    operation: Schema.String,
    thread_id: Schema.optional(Ids.ThreadId),
  },
) {}

export const ThreadActorError = Schema.Union([
  ThreadActorActionError,
  WorkspaceAccess.WorkspaceAccessError,
  WorkspaceAccess.WorkspaceAccessDenied,
  ThreadEventLog.ThreadEventLogError,
  AgentLoop.AgentLoopError,
  Database.DatabaseError,
  ThreadProjection.ThreadProjectionError,
  WorkspaceStore.WorkspaceStoreError,
]).annotate({ identifier: "Rika.RivetHost.ThreadActor.Error" })
export type ThreadActorError = typeof ThreadActorError.Type

export const EnsureThread = Action.make("EnsureThread", {
  payload: EnsureThreadPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const AcceptTurn = Action.make("AcceptTurn", {
  payload: AcceptTurnPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const ReplayThread = Action.make("ReplayThread", {
  payload: ThreadIdPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const GetSnapshot = Action.make("GetSnapshot", {
  payload: ThreadIdPayload,
  success: ThreadActorSnapshot,
  error: ThreadActorError,
})

export const ThreadActor = Actor.make("ThreadActor", {
  actions: [EnsureThread, AcceptTurn, ReplayThread, GetSnapshot],
})

export const emptyState = (): ThreadActorState => ({
  last_sequence: 0,
  message_count: 0,
  archived: false,
  active_turn_status: "idle",
})

export const snapshotFromState = (state: ThreadActorState, threadId: Ids.ThreadId): ThreadActorSnapshot => ({
  ...state,
  thread_id: state.thread_id ?? threadId,
})

export const stateFromEvents = (threadId: Ids.ThreadId, events: ReadonlyArray<Event.Event>): ThreadActorState =>
  events.reduce(applyEventToState, { ...emptyState(), thread_id: threadId })

export const applyEventToState = (state: ThreadActorState, event: Event.Event): ThreadActorState => {
  switch (event.type) {
    case "thread.created":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
      }
    case "message.added":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        message_count: state.message_count + 1,
        latest_message_id: event.data.message.id,
        latest_message_role: event.data.message.role,
        latest_message_text: textFromMessage(event.data.message),
      }
    case "turn.started":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        active_turn_id: event.turn_id,
        active_turn_status: "active",
      }
    case "turn.completed":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        active_turn_id: event.turn_id,
        active_turn_status: "completed",
      }
    case "turn.failed":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        active_turn_id: event.turn_id,
        active_turn_status: "failed",
      }
    case "thread.archived":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        archived: true,
      }
    case "thread.unarchived":
      return {
        ...state,
        thread_id: event.thread_id,
        last_sequence: event.sequence,
        archived: false,
      }
    default:
      return { ...state, thread_id: event.thread_id, last_sequence: event.sequence }
  }
}

const textFromMessage = (message: Message.Message) => Message.displayText(message)
