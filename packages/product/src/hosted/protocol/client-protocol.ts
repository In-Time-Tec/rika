import { Schema } from "effect"
import {
  ActorAttribution,
  CommitCursor,
  CommandId,
  EventId,
  FencingGeneration,
  HostedThread,
  HostedWorkspace,
  IdempotencyKey,
  JsonObject,
  LeaseId,
  HostedOwner,
  Presence,
  PresenceStatus,
  ProjectId,
  TerminalWriterLease,
  ThreadCommand,
  ThreadEvent,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "../model"

export const ClientCommand = Schema.Union([
  Schema.TaggedStruct("SubmitPrompt", { prompt: Schema.NonEmptyString }),
  Schema.TaggedStruct("Steer", { text: Schema.NonEmptyString }),
  Schema.TaggedStruct("Cancel", {}),
  Schema.TaggedStruct("TerminalInput", {
    data: Schema.String,
    writerLeaseId: LeaseId,
    writerGeneration: FencingGeneration,
  }),
])
export type ClientCommand = typeof ClientCommand.Type

export const ClientCommandEnvelope = Schema.TaggedStruct("AdmitCommand", {
  owner: HostedOwner,
  threadId: ThreadId,
  commandId: CommandId,
  idempotencyKey: IdempotencyKey,
  actor: ActorAttribution,
  command: ClientCommand,
})
export type ClientCommandEnvelope = typeof ClientCommandEnvelope.Type

export const ClientRequest = Schema.Union([
  Schema.TaggedStruct("CreateWorkspace", {
    owner: HostedOwner,
    projectId: Schema.optionalKey(ProjectId),
    workspaceId: WorkspaceId,
    actor: ActorAttribution,
    executorKind: Schema.Literals(["local_device", "e2b"]),
    inheritProjectGrants: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct("CreateThread", {
    owner: HostedOwner,
    projectId: Schema.optionalKey(ProjectId),
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    actor: ActorAttribution,
    executorKind: Schema.Literals(["local_device", "e2b"]),
    inheritProjectGrants: Schema.optionalKey(Schema.Boolean),
  }),
  ClientCommandEnvelope,
  Schema.TaggedStruct("SubscribeThread", {
    owner: HostedOwner,
    threadId: ThreadId,
    actor: ActorAttribution,
    afterCommitCursor: CommitCursor,
  }),
  Schema.TaggedStruct("AcknowledgeCursor", {
    owner: HostedOwner,
    threadId: ThreadId,
    actor: ActorAttribution,
    commitCursor: CommitCursor,
  }),
  Schema.TaggedStruct("AcquireTerminalWriter", {
    owner: HostedOwner,
    threadId: ThreadId,
    actor: ActorAttribution,
    leaseId: LeaseId,
    now: Timestamp,
    expiresAt: Timestamp,
  }),
  Schema.TaggedStruct("RenewTerminalWriter", {
    owner: HostedOwner,
    threadId: ThreadId,
    actor: ActorAttribution,
    leaseId: LeaseId,
    generation: FencingGeneration,
    now: Timestamp,
    expiresAt: Timestamp,
  }),
  Schema.TaggedStruct("PresenceHeartbeat", {
    owner: HostedOwner,
    threadId: ThreadId,
    actor: ActorAttribution,
    status: PresenceStatus,
    now: Timestamp,
    expiresAt: Timestamp,
  }),
])
export type ClientRequest = typeof ClientRequest.Type

export const ClientResponse = Schema.Union([
  Schema.TaggedStruct("WorkspaceCreated", { workspace: HostedWorkspace }),
  Schema.TaggedStruct("ThreadCreated", { thread: HostedThread }),
  Schema.TaggedStruct("CommandAdmitted", { command: ThreadCommand }),
  Schema.TaggedStruct("ThreadEventBatch", {
    owner: HostedOwner,
    threadId: ThreadId,
    events: Schema.Array(ThreadEvent),
    nextCursor: CommitCursor,
  }),
  Schema.TaggedStruct("ThreadEventBroadcast", { event: ThreadEvent }),
  Schema.TaggedStruct("TerminalWriterGranted", { lease: TerminalWriterLease }),
  Schema.TaggedStruct("PresenceSnapshot", {
    owner: HostedOwner,
    threadId: ThreadId,
    presence: Schema.Array(Presence),
  }),
  Schema.TaggedStruct("Rejected", {
    requestId: Schema.NullOr(Schema.Union([CommandId, EventId])),
    reason: Schema.NonEmptyString,
    details: JsonObject,
  }),
])
export type ClientResponse = typeof ClientResponse.Type

export const AuthenticatedClientConnection = Schema.Struct({
  actor: ActorAttribution,
  connectedAt: Timestamp,
})
