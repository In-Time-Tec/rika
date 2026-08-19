import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Layer, Schema } from "effect"
import { provideLayer } from "./product-test-layer"
import * as ServerHandshake from "../src/server/server-service-handshake"
import * as ServerService from "../src/server/server-service"

describe("Rika Server protocol", () => {
  it.effect("uses canonical profile and data root identity", () => {
    const crypto = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    )
    const identity = (profile: string) =>
      ServerService.ServiceRuntime.canonicalServiceIdentity(profile, "/tmp/rika").pipe(provideLayer(crypto))
    return Effect.gen(function* () {
      expect(yield* identity("default")).toBe(yield* identity("default"))
      expect(yield* identity("other")).not.toBe(yield* identity("default"))
    })
  })

  it("fails closed for credentials and uses build identity only for launches", () => {
    const unsigned = {
      family: "rika-server" as const,
      identity: "identity",
      clientNonce: "nonce",
      clientKind: "run" as const,
      connectRole: "launch" as const,
      buildIdentity: "build-a",
    }
    const base = { ...unsigned, clientProof: ServerHandshake.HandshakeProtocol.clientProof("token", unsigned) }
    expect(
      ServerHandshake.HandshakeProtocol.validateHandshake(base, {
        identity: "identity",
        token: "token",
        buildIdentity: "build-a",
      })._tag,
    ).toBe("Accepted")
    expect(
      ServerHandshake.HandshakeProtocol.validateHandshake(
        { ...base, clientProof: ServerHandshake.HandshakeProtocol.clientProof("wrong", unsigned) },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("AuthenticationFailed")
    expect(
      ServerHandshake.HandshakeProtocol.validateHandshake(
        { ...base, identity: "wrong" },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("IdentityMismatch")
    expect(
      ServerHandshake.HandshakeProtocol.validateHandshake(
        {
          ...base,
          buildIdentity: "build-b",
          clientProof: ServerHandshake.HandshakeProtocol.clientProof("token", {
            ...unsigned,
            buildIdentity: "build-b",
          }),
        },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("BuildMismatch")
    const reattachUnsigned = { ...unsigned, connectRole: "reattach" as const, buildIdentity: "build-b" }
    expect(
      ServerHandshake.HandshakeProtocol.validateHandshake(
        {
          ...reattachUnsigned,
          clientProof: ServerHandshake.HandshakeProtocol.clientProof("token", reattachUnsigned),
        },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("Accepted")
    expect(
      ServerHandshake.HandshakeProtocol.validateHandshake(
        { ...base, connectRole: "reattach" },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("AuthenticationFailed")
  })

  it("requires the current handshake fields and bounded non-empty transport identities", () => {
    const base = {
      family: "rika-server",
      identity: "identity",
      clientNonce: "nonce",
      clientKind: "run",
      connectRole: "launch",
      buildIdentity: "build-a",
      clientProof: "0".repeat(64),
    }
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        ...base,
        clientNonce: "",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        ...base,
        identity: "x".repeat(1_025),
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        ...base,
        buildIdentity: "x".repeat(1_025),
      }),
    ).toThrow()
    for (const connectRole of ["launch", "reattach"])
      expect(
        Schema.decodeUnknownSync(ServerService.ClientMessage)({
          ...base,
          connectRole,
        }),
      ).toMatchObject({ connectRole })
  })

  it("authenticates the server response and binds both nonces and the connection identity", () => {
    const handshake = {
      identity: "identity",
      clientNonce: "client-nonce",
      clientKind: "run" as const,
      connectRole: "launch" as const,
      buildIdentity: "build-a",
    }
    const accepted = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      _tag: "accepted",
      family: "rika-server",
      identity: handshake.identity,
      clientNonce: handshake.clientNonce,
      serviceNonce: "service-nonce",
      connectionId: "connection",
      buildIdentity: "build-a",
      serverProof: ServerHandshake.HandshakeProtocol.serverProof("token", handshake, {
        _tag: "accepted",
        family: "rika-server",
        identity: handshake.identity,
        clientNonce: handshake.clientNonce,
        serviceNonce: "service-nonce",
        connectionId: "connection",
        buildIdentity: "build-a",
      }),
    })
    expect(accepted._tag).toBe("accepted")
    if (accepted._tag !== "accepted") return
    expect(ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, accepted)).toBe(true)
    expect(ServerHandshake.HandshakeProtocol.verifyServerProof("wrong", handshake, accepted)).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof(
        "token",
        { ...handshake, clientNonce: "reflected" },
        accepted,
      ),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...accepted,
        connectionId: "foreign",
      }),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...accepted,
        buildIdentity: "build-b",
      }),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...accepted,
        serviceNonce: "foreign",
      }),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, { ...accepted, serverPid: 42 }),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", { ...handshake, connectRole: "reattach" }, accepted),
    ).toBe(false)

    const mismatchFields = {
      _tag: "build-mismatch" as const,
      family: "rika-server" as const,
      identity: handshake.identity,
      clientNonce: handshake.clientNonce,
      serviceNonce: "service-nonce",
      connectionId: "connection",
      buildIdentity: "build-b",
      serverPid: 123,
    }
    const mismatch = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      ...mismatchFields,
      serverProof: ServerHandshake.HandshakeProtocol.serverProof("token", handshake, mismatchFields),
    })
    expect(mismatch._tag).toBe("build-mismatch")
    if (mismatch._tag !== "build-mismatch") return
    expect(ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, mismatch)).toBe(true)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...mismatch,
        buildIdentity: "build-c",
      }),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, { ...mismatch, serverPid: 124 }),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...mismatch,
        connectionId: "other",
      }),
    ).toBe(false)
  })

  it("round-trips bounded ThreadView snapshots without undefined wire fields", () => {
    const message = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "feed",
      sequence: 1,
      event: {
        _tag: "ThreadViewSnapshot",
        snapshot: {
          thread: {
            id: "thread",
            lineage: { _tag: "Original" },
            workspace: "/work",
            title: "Thread",
            labels: [],
            pinned: false,
            archived: false,
            createdAt: 1,
            updatedAt: 1,
          },
          revision: 0,
          source: { projectionVersion: 1 },
          turns: [],
          pending: [],
          hasOlder: false,
          hasNewer: false,
          usage: {
            state: {
              costNanoUsd: 125_000_000,
              tokens: {
                total: 12,
                input: { total: 8, cacheRead: 2 },
                output: { total: 4, reasoning: 1 },
                failedProviderTotal: 2,
              },
              pricedAttempts: 1,
              unpricedAttempts: 1,
              countedAttempts: 2,
              uncountedAttempts: 0,
              sourceComplete: false,
              context: { requestOrdinal: 1, purpose: "conversation", inputTokens: 8 },
              contextPending: true,
              active: { _tag: "Available", accumulatedMillis: 50, activeSince: 100 },
            },
            contextCapacity: { contextWindow: 100, reserveTokens: 10 },
          },
        },
      },
    })
    const encoded = Schema.encodeSync(ServerService.ServerMessage)(message)
    const wire = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(encoded)
    expect(wire).not.toContain("oldestCursor")
    expect(wire).toContain("costNanoUsd")
    expect(wire).toContain("failedProviderTotal")
    expect(wire).not.toMatch(/runId|modelCallId|modelAttemptId/)
    expect(
      Schema.decodeUnknownSync(ServerService.ServerMessage)(
        Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(wire),
      ),
    ).toEqual(message)
  })

  it("accepts every current interactive command and rejects unknown command tags", () => {
    const commands = [
      { _tag: "Submit", prompt: "prompt", mode: "high", promptParts: [{ type: "text", text: "part" }] },
      { _tag: "Shell", command: "pwd", incognito: true },
      { _tag: "EditQueued", turnId: "turn", prompt: "edit" },
      { _tag: "Dequeue", turnId: "turn" },
      { _tag: "SteerQueued", turnId: "turn", text: "steer", requestId: "steer-queued-request" },
      { _tag: "Steer", text: "steer", requestId: "steer-request" },
      { _tag: "ApproveAuthorization", turnId: "turn", authorizationId: "authorization" },
      { _tag: "DenyAuthorization", turnId: "turn", authorizationId: "authorization" },
      { _tag: "InterruptAndSend", prompt: "replace" },
      { _tag: "Cancel" },
      { _tag: "Quit" },
      { _tag: "NewThread" },
      { _tag: "ArchiveThread" },
      { _tag: "ArchiveAndNewThread" },
      { _tag: "SelectThread", threadId: "thread" },
      { _tag: "ReadQueue", threadId: "thread" },
      { _tag: "PreviewThread", threadId: "thread", requestId: 42 },
      { _tag: "ReopenThread" },
    ]
    for (const [index, command] of commands.entries()) {
      const input = {
        _tag: "interactive-command",
        connectionId: "connection",
        requestId: "request",
        sessionId: "session",
        feedGeneration: "feed",
        commandSequence: index + 1,
        command,
      }
      const decoded = Schema.decodeUnknownSync(ServerService.ClientMessage)(input)
      expect(
        Schema.decodeUnknownSync(ServerService.ClientMessage)(Schema.encodeSync(ServerService.ClientMessage)(decoded)),
      ).toEqual(decoded)
    }
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        _tag: "interactive-command",
        connectionId: "connection",
        requestId: "request",
        sessionId: "session",
        feedGeneration: "feed",
        commandSequence: 1,
        command: { _tag: "OldCommand" },
      }),
    ).toThrow()
  })

  it("rejects sequence values outside the current server contract", () => {
    const client = {
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "feed",
    }
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        _tag: "interactive-command",
        ...client,
        commandSequence: 0,
        command: { _tag: "Cancel" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        _tag: "interactive-feed-ack",
        ...client,
        throughSequence: 0,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        _tag: "UnknownCommand",
        ...client,
        afterSequence: -1,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ServerMessage)({
        _tag: "interactive-started",
        ...client,
        feedCapacity: 0,
      }),
    ).toThrow()
  })

  it("round-trips the full bounded tentative preview identity and append changes", () => {
    const message = {
      _tag: "interactive-feed-event" as const,
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "feed",
      sequence: 1,
      event: {
        _tag: "ExecutionModelPreviewChanged" as const,
        threadId: "thread",
        turnId: "turn",
        preview: {
          _tag: "ModelPreview" as const,
          runId: "run",
          attemptFence: 2,
          turn: 3,
          modelCallId: "call",
          modelAttemptId: "attempt",
          attempt: 4,
          sequence: 5,
          changes: [
            { channel: "reasoning" as const, offset: 0, delta: "thinking" },
            { channel: "text" as const, offset: 0, delta: "tentative" },
          ],
        },
      },
    }
    const decoded = Schema.decodeUnknownSync(ServerService.ServerMessage)(message)
    expect(
      Schema.decodeUnknownSync(ServerService.ServerMessage)(Schema.encodeSync(ServerService.ServerMessage)(decoded)),
    ).toEqual(decoded)
  })
})
