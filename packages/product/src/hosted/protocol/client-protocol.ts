import { Schema } from "effect"
import {
  ActorAttribution,
  BetterAuthMemberId,
  ClientId,
  CommitCursor,
  CommandId,
  DeviceId,
  EventId,
  FencingGeneration,
  HostedThread,
  HostedWorkspace,
  IdempotencyKey,
  JsonObject,
  LeaseId,
  OrganizationId,
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
  organizationId: OrganizationId,
  threadId: ThreadId,
  memberId: BetterAuthMemberId,
  clientId: ClientId,
  commandId: CommandId,
  idempotencyKey: IdempotencyKey,
  actor: ActorAttribution,
  command: ClientCommand,
})
export type ClientCommandEnvelope = typeof ClientCommandEnvelope.Type

export const ClientRequest = Schema.Union([
  Schema.TaggedStruct("CreateWorkspace", {
    organizationId: OrganizationId,
    projectId: ProjectId,
    workspaceId: WorkspaceId,
    memberId: BetterAuthMemberId,
    clientId: ClientId,
    executorKind: Schema.Literals(["local_device", "e2b"]),
    inheritProjectGrants: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct("CreateThread", {
    organizationId: OrganizationId,
    projectId: ProjectId,
    workspaceId: WorkspaceId,
    threadId: ThreadId,
    memberId: BetterAuthMemberId,
    clientId: ClientId,
    executorKind: Schema.Literals(["local_device", "e2b"]),
    inheritProjectGrants: Schema.optionalKey(Schema.Boolean),
  }),
  ClientCommandEnvelope,
  Schema.TaggedStruct("SubscribeThread", {
    organizationId: OrganizationId,
    threadId: ThreadId,
    memberId: BetterAuthMemberId,
    clientId: ClientId,
    afterCommitCursor: CommitCursor,
  }),
  Schema.TaggedStruct("AcknowledgeCursor", {
    organizationId: OrganizationId,
    threadId: ThreadId,
    memberId: BetterAuthMemberId,
    clientId: ClientId,
    commitCursor: CommitCursor,
  }),
  Schema.TaggedStruct("AcquireTerminalWriter", {
    organizationId: OrganizationId,
    threadId: ThreadId,
    memberId: BetterAuthMemberId,
    clientId: ClientId,
    leaseId: LeaseId,
    now: Timestamp,
    expiresAt: Timestamp,
  }),
  Schema.TaggedStruct("RenewTerminalWriter", {
    organizationId: OrganizationId,
    threadId: ThreadId,
    memberId: BetterAuthMemberId,
    clientId: ClientId,
    leaseId: LeaseId,
    generation: FencingGeneration,
    now: Timestamp,
    expiresAt: Timestamp,
  }),
  Schema.TaggedStruct("PresenceHeartbeat", {
    organizationId: OrganizationId,
    threadId: ThreadId,
    memberId: BetterAuthMemberId,
    clientId: ClientId,
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
    organizationId: OrganizationId,
    threadId: ThreadId,
    events: Schema.Array(ThreadEvent),
    nextCursor: CommitCursor,
  }),
  Schema.TaggedStruct("ThreadEventBroadcast", { event: ThreadEvent }),
  Schema.TaggedStruct("TerminalWriterGranted", { lease: TerminalWriterLease }),
  Schema.TaggedStruct("PresenceSnapshot", {
    organizationId: OrganizationId,
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
  organizationId: OrganizationId,
  memberId: BetterAuthMemberId,
  clientId: ClientId,
  deviceId: DeviceId,
  connectedAt: Timestamp,
})
