import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
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
} from "../../src/hosted/model"
import { ClientMessage, ServerFrame, protocolVersion } from "../../src/hosted/protocol/client-protocol"

const codec = <S extends Schema.Constraint>(schema: S) =>
  schema as unknown as Schema.Codec<unknown, unknown, never, never>
const roundTrip = (schema: Schema.Constraint, value: unknown) => {
  const encoded = Schema.encodeUnknownSync(codec(schema))(value)
  return Schema.decodeUnknownSync(codec(schema))(JSON.parse(JSON.stringify(encoded)))
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
const envelope = (command: unknown) => ({ protocolVersion, requestId, command })
const mutation = { commandId, idempotencyKey, expectedThreadVersion }

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
        ...mutation,
        owner: { kind: "personal" },
        placement: "local",
        localRunnerTarget: { deviceId: "device-1", checkoutFingerprint: "checkout-1" },
      }),
      envelope({
        _tag: "CreateThread",
        ...mutation,
        owner: { kind: "organization", organizationId },
        projectId,
        placement: "e2b",
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
      envelope({ _tag: "InterruptAndSend", ...mutation, text: "stop and do this" }),
      envelope({ _tag: "Cancel", ...mutation }),
      envelope({ _tag: "Approve", ...mutation, turnId: "turn", authorizationId: "authorization", checkpoint }),
      envelope({ _tag: "Deny", ...mutation, turnId: "turn", authorizationId: "authorization", checkpoint }),
      envelope({ _tag: "AcknowledgeCursor", cursor }),
      envelope({ _tag: "Detach" }),
    ]
    expect(messages.map((message) => roundTrip(ClientMessage, message))).toEqual(messages)
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
      expect(() => Schema.decodeUnknownSync(ClientMessage)(forged)).toThrow()
    }
    expect(() => Schema.decodeUnknownSync(ClientMessage)({ ...base, protocolVersion: 2 })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ClientMessage)(envelope({ _tag: "Cancel", ...mutation, extra: true })),
    ).toThrow()
  })

  it("round trips accepted, rejected, event, and heartbeat server frames", () => {
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
      { protocolVersion, payload: { _tag: "Heartbeat", at: now } },
    ]
    expect(frames.map((frame) => roundTrip(ServerFrame, frame))).toEqual(frames)
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
