import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import * as ExecutionProjection from "../../../src/execution/projection/contract"
import {
  ActorAttribution,
  BetterAuthMemberId,
  BetterAuthUserId,
  ClientId,
  CommandId,
  CredentialReferenceMetadata,
  DeviceId,
  HostedOwner,
  IdempotencyKey,
  OrganizationId,
  ProjectId,
  RequestId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "../../../src/hosted/model"
import {
  ClientMessage,
  inspectClientProtocolVersion,
  protocolMismatchFrame,
  protocolMismatchMessage,
  protocolVersion,
  ServerFrame,
} from "../../../src/hosted/protocol/client"

const roundTrip = <A, I>(schema: Schema.Codec<A, I, never, never>, value: A) => {
  const jsonCodec = Schema.fromJsonString(schema)
  const encoded = Schema.encodeUnknownSync(jsonCodec)(value)
  return Schema.decodeSync(jsonCodec)(encoded)
}

const userId = BetterAuthUserId.make("user")
const organizationId = OrganizationId.make("organization")
const membershipId = BetterAuthMemberId.make("membership")
const deviceId = DeviceId.make("device")
const clientId = ClientId.make("client")
const projectId = ProjectId.make("project")
const threadId = ThreadId.make("thread")
const requestId = RequestId.make("request")
const commandId = CommandId.make("command")
const idempotencyKey = IdempotencyKey.make("command-key")
const expectedThreadVersion = ThreadVersion.make("3")
const cursor = ThreadEventCursor.make("8")
const now = Timestamp.make("2026-01-01T00:00:00.000Z")
const checkpoint = { version: 4 as const, cursor: "projector-cursor", state: "{}" }
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
type ClientCommand = typeof ClientMessage.Type.command
const envelope = (command: ClientCommand) => ({ protocolVersion, requestId, command })
const admitted = { commandId, idempotencyKey, expectedThreadVersion }
const mutation = { threadId, ...admitted }

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

describe("hosted Thread client protocol", () => {
  it("round trips every interactive command through one versioned envelope", () => {
    const messages = [
      envelope({
        _tag: "CreateThread",
        ...admitted,
        owner: { kind: "personal" },
        executorKind: "runner",
        runnerTarget: { deviceId: "device-1", checkoutFingerprint: "checkout-1" },
      }),
      envelope({
        _tag: "CreateThread",
        ...admitted,
        owner: { kind: "organization", organizationId },
        projectId,
        executorKind: "orb",
        repositoryRef: { repositoryId: "repository", ref: "refs/heads/main" },
      }),
      envelope({ _tag: "AttachThread", threadId, afterCursor: cursor }),
      envelope({
        _tag: "SubmitPrompt",
        ...mutation,
        text: "hello",
        mode: "high",
        attachments: [{ mediaType: "image/png", data: "aW1hZ2U", filename: "image.png" }],
      }),
      envelope({ _tag: "Steer", ...mutation, text: "focus", targetTurnId: "turn" }),
      envelope({ _tag: "InterruptAndSend", ...mutation, text: "stop and do this", targetTurnId: "turn" }),
      envelope({ _tag: "Cancel", ...mutation, target: { _tag: "Turn", turnId: "turn" } }),
      envelope({ _tag: "Approve", ...mutation, turnId: "turn", authorizationId: "authorization", checkpoint }),
      envelope({ _tag: "Deny", ...mutation, turnId: "turn", authorizationId: "authorization", checkpoint }),
      envelope({
        _tag: "EnsureRepositoryService",
        ...mutation,
        service: { serviceId: "docs", command: "bun", args: ["run", "dev"], cwd: "." },
      }),
      envelope({ _tag: "StopRepositoryService", ...mutation, serviceId: "docs" }),
      envelope({ _tag: "InspectWorkspaceFile", threadId, path: "src/main.ts", maximumBytes: 1024 }),
      envelope({ _tag: "AcknowledgeCursor", threadId, cursor }),
      envelope({ _tag: "UpdatePresence", threadId, status: "viewing" }),
      envelope({ _tag: "OpenPortal", threadId, port: 3000 }),
      envelope({ _tag: "Detach" }),
    ]
    expect(messages.map((message) => roundTrip(ClientMessage, message))).toEqual(messages)
    for (const message of messages) {
      if (
        message.command._tag === "CreateThread" ||
        message.command._tag === "AttachThread" ||
        message.command._tag === "Detach"
      )
        continue
      const { threadId: _, ...withoutThread } = message.command
      expect(() => Schema.decodeSync(ClientMessage)({ ...message, command: withoutThread })).toThrow()
    }
  })

  it("rejects malformed variants and every client-supplied trusted identity field", () => {
    const base = envelope({ _tag: "SubmitPrompt", ...mutation, text: "hello" })
    for (const forged of [
      { ...base, actor: personalActor },
      { ...base, userId },
      { ...base, membershipId },
      { ...base, ownerId: "owner" },
      { ...base, command: { ...base.command, actor: personalActor } },
      { ...base, command: { ...base.command, membershipId } },
    ]) {
      expect(() => Schema.decodeSync(ClientMessage)(forged)).toThrow()
    }
    expect(() => Schema.decodeSync(ClientMessage)({ ...base, protocolVersion: 1 })).toThrow()
    expect(() => Schema.decodeSync(ClientMessage)(envelope({ _tag: "Cancel", ...mutation, extra: true }))).toThrow()
    expect(() =>
      Schema.decodeSync(ClientMessage)(
        envelope({ _tag: "CreateThread", ...admitted, owner: { kind: "personal" }, placement: "local" }),
      ),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(ClientMessage)(
        envelope({ _tag: "CreateThread", ...admitted, owner: { kind: "personal" }, executorKind: "runner" }),
      ),
    ).toThrow()
    expect(() =>
      Schema.decodeSync(ClientMessage)(
        envelope({
          _tag: "CreateThread",
          ...mutation,
          owner: { kind: "personal" },
          executorKind: "orb",
          runnerTarget: { deviceId: "device-1", checkoutFingerprint: "checkout-1" },
        }),
      ),
    ).toThrow()
  })

  it("rejects a previous protocol version and encodes a mismatch frame the caller can still read", () => {
    const body = JSON.stringify({ protocolVersion: 1, requestId: "request-1", command: { _tag: "Detach" } })
    expect(inspectClientProtocolVersion(body)).toEqual({ protocolVersion: 1, requestId: "request-1" })
    const frame = Schema.decodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          protocolVersion: Schema.Finite,
          payload: Schema.Struct({ message: Schema.String, requestId: Schema.String }),
        }),
      ),
    )(protocolMismatchFrame({ protocolVersion: 1, requestId: "request-1" }))
    expect(frame.protocolVersion).toBe(1)
    expect(frame.payload.requestId).toBe("request-1")
    expect(frame.payload.message).toBe(protocolMismatchMessage)
  })

  it("round trips accepted, rejected, event, and heartbeat server frames", () => {
    const snapshot = {
      executorKind: "orb" as const,
      view: {
        thread: {
          id: threadId satisfies never,
          workspace: "workspace",
          title: "Thread",
          labels: [],
          pinned: false,
          archived: false,
          lineage: { _tag: "Original" as const },
          createdAt: 1,
          updatedAt: 1,
        },
        revision: 0,
        source: { projectionVersion: ExecutionProjection.projectionVersion },
        turns: [],
        pending: [],
        hasOlder: false,
        hasNewer: false,
        usage: { state: ExecutionProjection.emptyUsageState() },
      },
      pendingAuthorizations: [],
    }
    const frames = [
      {
        protocolVersion,
        payload: {
          _tag: "CommandAccepted",
          requestId,
          commandId,
          threadId,
          threadVersion: ThreadVersion.make("4"),
          cursor,
          result: { _tag: "Applied" },
        },
      },
      {
        protocolVersion,
        payload: {
          _tag: "CommandAccepted",
          requestId,
          commandId,
          threadId,
          threadVersion: ThreadVersion.make("4"),
          cursor,
          result: { _tag: "PromptAdmitted", status: "queued" },
        },
      },
      {
        protocolVersion,
        payload: {
          _tag: "CommandRejected",
          requestId,
          commandId,
          threadId,
          reason: "stale-version",
          currentThreadVersion: ThreadVersion.make("4"),
          currentCursor: cursor,
          message: "Thread version is stale",
          details: {},
        },
      },
      {
        protocolVersion,
        payload: {
          _tag: "ThreadEvent",
          event: {
            threadId,
            sequence: "1",
            cursor,
            threadVersion: ThreadVersion.make("4"),
            event: { _tag: "ExecutionControlled", action: "cancelled" },
            createdAt: now,
          },
        },
      },
      {
        protocolVersion,
        payload: {
          _tag: "ThreadAttached",
          requestId,
          threadId,
          snapshotThreadVersion: ThreadVersion.make("4"),
          snapshotCursor: cursor,
          threadVersion: ThreadVersion.make("4"),
          cursor,
          snapshot,
          events: [],
          participants: [{ actor: personalActor, status: "viewing" }],
        },
      },
      {
        protocolVersion,
        payload: {
          _tag: "ThreadSnapshot",
          threadId,
          threadVersion: ThreadVersion.make("4"),
          cursor,
          snapshot,
        },
      },
      {
        protocolVersion,
        payload: {
          _tag: "ThreadPreview",
          threadId,
          turnId: "turn",
          preview: {
            _tag: "ModelPreview",
            runId: "run",
            attemptFence: 1,
            turn: 0,
            modelCallId: "call",
            modelAttemptId: "attempt",
            attempt: 1,
            sequence: 0,
            changes: [{ channel: "text", offset: 0, delta: "Hello" }],
          },
        },
      },
      { protocolVersion, payload: { _tag: "ThreadPreviewReset", threadId } },
      { protocolVersion, payload: { _tag: "Heartbeat", at: now } },
    ]
    expect(frames.map((frame) => roundTrip(ServerFrame, frame))).toEqual(frames)
  })
})

describe("credential reference metadata", () => {
  it("accepts non-secret metadata and rejects nested secret-bearing keys", () => {
    expect(Schema.decodeSync(CredentialReferenceMetadata)({ region: "us-west-2", version: 3 })).toEqual({
      region: "us-west-2",
      version: 3,
    })
    expect(() =>
      Schema.decodeSync(CredentialReferenceMetadata)({ provider: { accessToken: "secret material" } }),
    ).toThrow("credential metadata must not contain secret material")
  })
})
