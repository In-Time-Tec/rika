import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import {
  AuditEventId,
  BetterAuthMemberId,
  CheckpointId,
  ClientId,
  CommitCursor,
  CommandId,
  CredentialReferenceMetadata,
  DeviceId,
  EventId,
  ExecutorInstanceId,
  FencingGeneration,
  IdempotencyKey,
  LeaseId,
  OrganizationId,
  ProjectId,
  Sequence,
  ThreadId,
  Timestamp,
  WorkspaceId,
} from "../../src/hosted/hosted-authority-model"
import { ClientToControlPlane, ControlPlaneToClient } from "../../src/hosted/protocol/client-control-plane-protocol"
import {
  ControlPlaneToExecutor,
  ExecutorToControlPlane,
} from "../../src/hosted/protocol/executor-control-plane-protocol"

const codec = <S extends Schema.Constraint>(schema: S) =>
  schema as unknown as Schema.Codec<unknown, unknown, never, never>
const roundTrip = (schema: Schema.Constraint, value: unknown) => {
  const encoded = Schema.encodeUnknownSync(codec(schema))(value)
  return Schema.decodeUnknownSync(codec(schema))(JSON.parse(JSON.stringify(encoded)))
}

const organizationId = OrganizationId.make("org")
const projectId = ProjectId.make("project")
const workspaceId = WorkspaceId.make("workspace")
const threadId = ThreadId.make("thread")
const memberId = BetterAuthMemberId.make("member")
const deviceId = DeviceId.make("device")
const clientId = ClientId.make("client")
const executorInstanceId = ExecutorInstanceId.make("executor")
const leaseId = LeaseId.make("lease")
const generation = FencingGeneration.make("7")
const sequence = Sequence.make("12")
const commitCursor = CommitCursor.make("21")
const now = Timestamp.make("2026-01-01T00:00:00.000Z")
const expiresAt = Timestamp.make("2026-01-01T00:01:00.000Z")
const actor = { _tag: "AuthenticatedMember" as const, organizationId, memberId, clientId, deviceId }
const thread = {
  id: threadId,
  organizationId,
  projectId,
  workspaceId,
  createdByMemberId: memberId,
  executorKind: "e2b" as const,
  inheritProjectGrants: true,
  createdAt: now,
}
const workspace = {
  id: workspaceId,
  organizationId,
  projectId,
  createdByMemberId: memberId,
  executorKind: "e2b" as const,
  inheritProjectGrants: true,
  createdAt: now,
}
const command = {
  organizationId,
  threadId,
  memberId,
  clientId,
  commandId: CommandId.make("command"),
  idempotencyKey: IdempotencyKey.make("command-key"),
  actor,
  sequence,
  commitCursor,
  command: { _tag: "SubmitPrompt", prompt: "hello" },
  admittedAt: now,
}
const event = {
  organizationId,
  threadId,
  eventId: EventId.make("event"),
  idempotencyKey: IdempotencyKey.make("event-key"),
  executorInstanceId,
  assignmentGeneration: generation,
  sequence,
  commitCursor,
  commandSequence: sequence,
  event: { _tag: "TerminalOutput", data: "hello" },
  createdAt: now,
}
const writer = {
  organizationId,
  threadId,
  memberId,
  clientId,
  leaseId,
  generation,
  acquiredAt: now,
  renewedAt: now,
  expiresAt,
}
const presence = {
  organizationId,
  threadId,
  memberId,
  clientId,
  status: "controlling" as const,
  lastSeenAt: now,
  expiresAt,
}
const executor = {
  id: executorInstanceId,
  organizationId,
  executorKind: "e2b" as const,
  deviceId: null,
  status: "online" as const,
  connectedAt: now,
  lastSeenAt: now,
}
const assignment = {
  organizationId,
  threadId,
  executorInstanceId,
  executorKind: "e2b" as const,
  leaseId,
  generation,
  acquiredAt: now,
  renewedAt: now,
  expiresAt,
}
const checkpoint = {
  id: CheckpointId.make("checkpoint"),
  organizationId,
  threadId,
  executorInstanceId,
  assignmentGeneration: generation,
  eventSequence: sequence,
  batonCheckpointReference: "baton-checkpoint-reference",
  metadata: { compressed: true },
  createdAt: now,
}

describe("client control-plane protocol", () => {
  it("round trips every client request variant", () => {
    const values = [
      {
        _tag: "CreateWorkspace",
        organizationId,
        projectId,
        workspaceId,
        memberId,
        clientId,
        executorKind: "e2b",
        inheritProjectGrants: true,
      },
      {
        _tag: "CreateThread",
        organizationId,
        projectId,
        workspaceId,
        threadId,
        memberId,
        clientId,
        executorKind: "e2b",
        inheritProjectGrants: true,
      },
      {
        _tag: "AdmitCommand",
        organizationId,
        threadId,
        memberId,
        clientId,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        actor,
        command: { _tag: "TerminalInput", data: "ls\n", writerLeaseId: leaseId, writerGeneration: generation },
      },
      { _tag: "SubscribeThread", organizationId, threadId, memberId, clientId, afterCommitCursor: commitCursor },
      { _tag: "AcknowledgeCursor", organizationId, threadId, memberId, clientId, commitCursor },
      { _tag: "AcquireTerminalWriter", organizationId, threadId, memberId, clientId, leaseId, now, expiresAt },
      {
        _tag: "RenewTerminalWriter",
        organizationId,
        threadId,
        memberId,
        clientId,
        leaseId,
        generation,
        now,
        expiresAt,
      },
      {
        _tag: "PresenceHeartbeat",
        organizationId,
        threadId,
        memberId,
        clientId,
        status: "viewing",
        now,
        expiresAt,
      },
    ]
    expect(values.map((value) => roundTrip(ClientToControlPlane, value))).toEqual(values)
  })

  it("round trips every control-plane response variant including terminal output broadcast", () => {
    const values = [
      { _tag: "WorkspaceCreated", workspace },
      { _tag: "ThreadCreated", thread },
      { _tag: "CommandAdmitted", command },
      { _tag: "ThreadEventBatch", organizationId, threadId, events: [event], nextCursor: commitCursor },
      { _tag: "ThreadEventBroadcast", event },
      { _tag: "TerminalWriterGranted", lease: writer },
      { _tag: "PresenceSnapshot", organizationId, threadId, presence: [presence] },
      {
        _tag: "Rejected",
        requestId: command.commandId,
        reason: "denied",
        details: { auditEventId: AuditEventId.make("audit") },
      },
    ]
    expect(values.map((value) => roundTrip(ControlPlaneToClient, value))).toEqual(values)
  })
})

describe("executor control-plane protocol", () => {
  it("round trips every executor request variant", () => {
    const values = [
      { _tag: "RegisterExecutor", executor },
      {
        _tag: "AcquireAssignment",
        organizationId,
        threadId,
        executorInstanceId,
        executorKind: "e2b",
        leaseId,
        now,
        expiresAt,
      },
      {
        _tag: "RenewAssignment",
        organizationId,
        threadId,
        executorInstanceId,
        leaseId,
        generation,
        now,
        expiresAt,
      },
      {
        _tag: "AppendThreadEvent",
        organizationId,
        threadId,
        eventId: event.eventId,
        idempotencyKey: event.idempotencyKey,
        executorInstanceId,
        leaseId,
        assignmentGeneration: generation,
        commandSequence: sequence,
        event: event.event,
        createdAt: now,
      },
      {
        _tag: "SaveCheckpoint",
        checkpointId: checkpoint.id,
        organizationId,
        threadId,
        executorInstanceId,
        leaseId,
        assignmentGeneration: generation,
        eventSequence: sequence,
        batonCheckpointReference: checkpoint.batonCheckpointReference,
        metadata: checkpoint.metadata,
        createdAt: now,
      },
    ]
    expect(values.map((value) => roundTrip(ExecutorToControlPlane, value))).toEqual(values)
  })

  it("round trips every control-plane executor response variant", () => {
    const values = [
      { _tag: "ExecutorRegistered", executor },
      { _tag: "AssignmentGranted", assignment },
      { _tag: "AssignmentRenewed", assignment },
      { _tag: "EventAppended", event },
      { _tag: "CheckpointStored", checkpoint },
      { _tag: "Rejected", reason: "stale fence", expectedGeneration: generation },
    ]
    expect(values.map((value) => roundTrip(ControlPlaneToExecutor, value))).toEqual(values)
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
