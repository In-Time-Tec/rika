import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  ActorAttribution,
  AuditEventId,
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  CommitCursor,
  CommandId,
  CredentialReferenceMetadata,
  DeviceId,
  EventId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  HostedOwner,
  IdempotencyKey,
  LeaseId,
  OrganizationId,
  OwnerId,
  ProjectId,
  Sequence,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "../../src/hosted/model"
import { ClientRequest, ClientResponse } from "../../src/hosted/protocol/client-protocol"

const codec = <S extends Schema.Constraint>(schema: S) =>
  schema as unknown as Schema.Codec<unknown, unknown, never, never>
const roundTrip = (schema: Schema.Constraint, value: unknown) => {
  const encoded = Schema.encodeUnknownSync(codec(schema))(value)
  return Schema.decodeUnknownSync(codec(schema))(JSON.parse(JSON.stringify(encoded)))
}

const userId = BetterAuthUserId.make("user")
const organizationId = OrganizationId.make("organization")
const ownerId = OwnerId.make("owner")
const membershipId = BetterAuthMemberId.make("membership")
const deviceId = DeviceId.make("device")
const clientId = ClientId.make("client")
const projectId = ProjectId.make("project")
const workspaceId = WorkspaceId.make("workspace")
const threadId = ThreadId.make("thread")
const assignmentId = ExecutorAssignmentId.make("assignment")
const executorInstanceId = ExecutorInstanceId.make("executor")
const leaseId = LeaseId.make("lease")
const generation = FencingGeneration.make("7")
const sequence = Sequence.make("12")
const commitCursor = CommitCursor.make("21")
const now = Timestamp.make("2026-01-01T00:00:00.000Z")
const expiresAt = Timestamp.make("2026-01-01T00:01:00.000Z")
const personalOwner = { _tag: "PersonalOwner" as const, userId }
const organizationOwner = { _tag: "OrganizationOwner" as const, organizationId }
const personalActor = { _tag: "PersonalActor" as const, owner: personalOwner, userId, clientId, deviceId }
const organizationActor = {
  _tag: "OrganizationActor" as const,
  owner: organizationOwner,
  userId,
  membershipId,
  clientId,
  deviceId,
}
const workspace = {
  id: workspaceId,
  ownerId,
  createdByUserId: userId,
  executorKind: "local_device" as const,
  inheritProjectGrants: false,
  createdAt: now,
}
const thread = {
  id: threadId,
  ownerId,
  projectId,
  workspaceId,
  createdByUserId: userId,
  executorKind: "e2b" as const,
  inheritProjectGrants: true,
  createdAt: now,
}
const command = {
  ownerId,
  threadId,
  commandId: CommandId.make("command"),
  idempotencyKey: IdempotencyKey.make("command-key"),
  actor: organizationActor,
  sequence,
  commitCursor,
  command: { _tag: "SubmitPrompt", prompt: "hello" },
  admittedAt: now,
}
const event = {
  ownerId,
  threadId,
  eventId: EventId.make("event"),
  idempotencyKey: IdempotencyKey.make("event-key"),
  assignmentId,
  executorInstanceId,
  assignmentGeneration: generation,
  leaseEpoch: generation,
  sequence,
  commitCursor,
  commandSequence: sequence,
  event: { _tag: "TerminalOutput", data: "hello" },
  createdAt: now,
}
const writer = {
  ownerId,
  threadId,
  actor: organizationActor,
  leaseId,
  generation,
  acquiredAt: now,
  renewedAt: now,
  expiresAt,
}
const presence = {
  ownerId,
  threadId,
  actor: personalActor,
  status: "controlling" as const,
  lastSeenAt: now,
  expiresAt,
}

describe("hosted owner and actor attribution", () => {
  it("round trips personal and organization attribution", () => {
    expect(roundTrip(ActorAttribution, personalActor)).toEqual(personalActor)
    expect(roundTrip(ActorAttribution, organizationActor)).toEqual(organizationActor)
  })

  it("rejects ownerless and mixed variants", () => {
    expect(() => Schema.decodeUnknownSync(HostedOwner)({ _tag: "PersonalOwner" })).toThrow()
    expect(() => Schema.decodeUnknownSync(HostedOwner)({ _tag: "PersonalOwner", userId, organizationId })).toThrow()
    expect(() => Schema.decodeUnknownSync(ActorAttribution)({ ...personalActor, membershipId })).toThrow()
    expect(() => Schema.decodeUnknownSync(ActorAttribution)({ ...organizationActor, owner: personalOwner })).toThrow()
  })
})

describe("client api protocol", () => {
  it("round trips every request variant for personal and organization owners", () => {
    const requests = [
      {
        _tag: "CreateWorkspace",
        owner: personalOwner,
        workspaceId,
        actor: personalActor,
        executorKind: "local_device",
      },
      {
        _tag: "CreateThread",
        owner: organizationOwner,
        projectId,
        workspaceId,
        threadId,
        actor: organizationActor,
        executorKind: "e2b",
        inheritProjectGrants: true,
      },
      {
        _tag: "AdmitCommand",
        owner: organizationOwner,
        threadId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        actor: organizationActor,
        command: {
          _tag: "TerminalInput",
          data: "ls\n",
          writerLeaseId: leaseId,
          writerGeneration: generation,
        },
      },
      {
        _tag: "SubscribeThread",
        owner: personalOwner,
        threadId,
        actor: personalActor,
        afterCommitCursor: commitCursor,
      },
      {
        _tag: "AcknowledgeCursor",
        owner: organizationOwner,
        threadId,
        actor: organizationActor,
        commitCursor,
      },
      {
        _tag: "AcquireTerminalWriter",
        owner: organizationOwner,
        threadId,
        actor: organizationActor,
        leaseId,
        now,
        expiresAt,
      },
      {
        _tag: "RenewTerminalWriter",
        owner: organizationOwner,
        threadId,
        actor: organizationActor,
        leaseId,
        generation,
        now,
        expiresAt,
      },
      {
        _tag: "PresenceHeartbeat",
        owner: personalOwner,
        threadId,
        actor: personalActor,
        status: "viewing",
        now,
        expiresAt,
      },
    ]
    expect(requests.map((request) => roundTrip(ClientRequest, request))).toEqual(requests)
  })

  it("round trips every response variant", () => {
    const responses = [
      { _tag: "WorkspaceCreated", workspace },
      { _tag: "ThreadCreated", thread },
      { _tag: "CommandAdmitted", command },
      { _tag: "ThreadEventBatch", owner: organizationOwner, threadId, events: [event], nextCursor: commitCursor },
      { _tag: "ThreadEventBroadcast", event },
      { _tag: "TerminalWriterGranted", lease: writer },
      { _tag: "PresenceSnapshot", owner: personalOwner, threadId, presence: [presence] },
      {
        _tag: "Rejected",
        requestId: command.commandId,
        reason: "denied",
        details: { auditEventId: AuditEventId.make("audit") },
      },
    ]
    expect(responses.map((response) => roundTrip(ClientResponse, response))).toEqual(responses)
  })
})

describe("credential reference metadata", () => {
  it("accepts non-secret metadata and rejects nested secret-bearing keys", () => {
    expect(Schema.decodeUnknownSync(CredentialReferenceMetadata)({ region: "us-west-2", version: 3 })).toEqual({
      region: "us-west-2",
      version: 3,
    })
    expect(() =>
      Schema.decodeUnknownSync(CredentialReferenceMetadata)({ provider: { accessToken: "secret material" } }),
    ).toThrow("credential metadata must not contain secret material")
  })
})
