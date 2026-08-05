import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Layer, Runtime, Schema } from "effect"
import { provideLayer } from "./product-test-layer"
import * as ServerHandshake from "../src/server/server-service-handshake"
import * as ServerService from "../src/server/server-service"

describe("Rika Server protocol", () => {
  it("supersedes only an idle server for a launching client", () => {
    expect(
      ServerHandshake.HandshakeProtocol.replacementDisposition({
        connectRole: "launch",
        hasActiveExecutionWork: false,
      }),
    ).toBe("supersede")
    expect(
      ServerHandshake.HandshakeProtocol.replacementDisposition({
        connectRole: "launch",
        hasActiveExecutionWork: true,
      }),
    ).toBe("defer")
    expect(
      ServerHandshake.HandshakeProtocol.replacementDisposition({
        connectRole: "reattach",
        hasActiveExecutionWork: false,
      }),
    ).toBe("restart")
    expect(
      ServerHandshake.HandshakeProtocol.replacementDisposition({
        connectRole: "reattach",
        hasActiveExecutionWork: true,
      }),
    ).toBe("restart")
  })

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

  it("fails closed for token and identity mismatches", () => {
    const unsigned = {
      family: "rika-server" as const,
      identity: "identity",
      clientNonce: "nonce",
      clientKind: "run" as const,
      connectRole: "launch" as const,
      protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
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
          protocolVersion: 0,
          clientProof: ServerHandshake.HandshakeProtocol.clientProof("token", { ...unsigned, protocolVersion: 0 }),
        },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("ProtocolMismatch")
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
    expect(
      ServerHandshake.HandshakeProtocol.validateHandshake(
        { ...base, protocolVersion: 0, buildIdentity: "build-b" },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("AuthenticationFailed")
  })

  it("requires an explicit protocol version and bounded non-empty transport identities", () => {
    const base = {
      family: "rika-server",
      identity: "identity",
      clientNonce: "nonce",
      clientKind: "run",
      clientProof: "0".repeat(64),
    }
    expect(() => Schema.decodeUnknownSync(ServerService.ClientMessage)(base)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        ...base,
        protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        ...base,
        protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "build-a",
        clientNonce: "",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        ...base,
        protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "build-a",
        identity: "x".repeat(1_025),
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ClientMessage)({
        ...base,
        protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "x".repeat(1_025),
      }),
    ).toThrow()
    for (const connectRole of ["launch", "reattach"])
      expect(
        Schema.decodeUnknownSync(ServerService.ClientMessage)({
          ...base,
          connectRole,
          protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
          buildIdentity: "build-a",
        }),
      ).toMatchObject({ connectRole })
  })

  it("authenticates the server response and binds both nonces and the connection identity", () => {
    const handshake = {
      identity: "identity",
      clientNonce: "client-nonce",
      clientKind: "run" as const,
      connectRole: "launch" as const,
      protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
      buildIdentity: "build-a",
    }
    const accepted = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      _tag: "accepted",
      family: "rika-server",
      identity: handshake.identity,
      clientNonce: handshake.clientNonce,
      serviceNonce: "service-nonce",
      connectionId: "connection",
      protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
      buildIdentity: "build-a",
      serverProof: ServerHandshake.HandshakeProtocol.serverProof("token", handshake, {
        _tag: "accepted",
        family: "rika-server",
        identity: handshake.identity,
        clientNonce: handshake.clientNonce,
        serviceNonce: "service-nonce",
        connectionId: "connection",
        protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
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
        protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion + 1,
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

    const incompatibleFields = {
      _tag: "incompatible" as const,
      disposition: "supersede" as const,
      replacementGuard: ServerHandshake.HandshakeProtocol.replacementGuard,
      family: "rika-server" as const,
      identity: handshake.identity,
      clientNonce: handshake.clientNonce,
      serviceNonce: "service-nonce",
      connectionId: "connection",
      protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
      buildIdentity: "build-b",
      serverPid: 123,
    }
    const incompatible = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      ...incompatibleFields,
      serverProof: ServerHandshake.HandshakeProtocol.serverProof("token", handshake, incompatibleFields),
    })
    expect(incompatible._tag).toBe("incompatible")
    if (incompatible._tag !== "incompatible") return
    expect(ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, incompatible)).toBe(true)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...incompatible,
        disposition: "restart",
      }),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...incompatible,
        disposition: "defer",
      }),
    ).toBe(false)
    expect(() =>
      Schema.decodeUnknownSync(ServerService.ServerMessage)({ ...incompatible, replacementGuard: "unattested" }),
    ).toThrow()
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, { ...incompatible, serverPid: 124 }),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...incompatible,
        connectionId: "other",
      }),
    ).toBe(false)
  })

  it("accepts only incompatibility responses justified by the connection role", () => {
    expect(
      ServerHandshake.HandshakeProtocol.isValidIncompatibility("launch", {
        protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "other-build",
      }),
    ).toBe(true)
    expect(
      ServerHandshake.HandshakeProtocol.isValidIncompatibility("launch", {
        protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "rika-development-build",
      }),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.isValidIncompatibility("reattach", {
        protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "other-build",
      }),
    ).toBe(false)
    expect(
      ServerHandshake.HandshakeProtocol.isValidIncompatibility("reattach", {
        protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion - 1,
        buildIdentity: "rika-development-build",
      }),
    ).toBe(true)
  })

  it("round-trips empty and semantic transcript pages without undefined wire fields", () => {
    const message = Schema.decodeUnknownSync(ServerService.ServerMessage)({
      _tag: "interactive-feed-event",
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "feed",
      sequence: 1,
      event: {
        _tag: "SelectionLoaded",
        selectionEpoch: 1,
        activitySequence: 0,
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
        entries: [],
        hasOlder: false,
        threadCostUsd: 0,
        queueRevision: 0,
        queue: [],
      },
    })
    const encoded = Schema.encodeSync(ServerService.ServerMessage)(message)
    const wire = Schema.encodeSync(Schema.UnknownFromJsonString)(encoded)
    expect(wire).not.toContain("oldestCursor")
    expect(
      Schema.decodeUnknownSync(ServerService.ServerMessage)(Schema.decodeSync(Schema.UnknownFromJsonString)(wire)),
    ).toEqual(message)
  })

  it("accepts every current interactive command and rejects unknown command tags", () => {
    const commands = [
      { _tag: "Submit", prompt: "prompt", mode: "high", promptParts: [{ type: "text", text: "part" }] },
      { _tag: "Shell", command: "pwd", incognito: true },
      { _tag: "EditQueued", turnId: "turn", prompt: "edit" },
      { _tag: "Dequeue", turnId: "turn" },
      { _tag: "SteerQueued", turnId: "turn", text: "steer" },
      { _tag: "Steer", text: "steer" },
      { _tag: "InterruptAndSend", prompt: "replace" },
      { _tag: "Cancel" },
      { _tag: "Quit" },
      { _tag: "NewThread" },
      { _tag: "SelectThread", threadId: "thread", selectionEpoch: 3 },
      { _tag: "ReadQueue", threadId: "thread" },
      {
        _tag: "LoadOlder",
        threadId: "thread",
        selectionEpoch: 3,
        before: { createdAt: 1, turnId: "turn", orderKey: "turn:user" },
        loadedKeys: [],
      },
      {
        _tag: "LoadNewer",
        threadId: "thread",
        selectionEpoch: 3,
        after: { createdAt: 1, turnId: "turn", orderKey: "key" },
      },
      { _tag: "PreviewThread", threadId: "thread" },
      { _tag: "ReopenThread", selectionEpoch: 4 },
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

  it("marks a restart-required failure with the dedicated runtime exit code", () => {
    expect(ServerService.ServiceRuntime.runtimeRestartExitCode).toBe(75)
    const restart = ServerService.ServerRestartRequired.make({ message: "server upgraded", threadId: "thread-1" })
    expect(restart[Runtime.errorExitCode]).toBe(ServerService.ServiceRuntime.runtimeRestartExitCode)
    expect(Schema.is(ServerService.ServerRestartRequired)(restart)).toBe(true)
    const decoded = Schema.decodeUnknownSync(ServerService.ServerRestartRequired)({
      _tag: "ServerRestartRequired",
      message: "server upgraded",
    })
    expect(decoded.threadId).toBeUndefined()
    expect(Schema.encodeSync(ServerService.ServerRestartRequired)(restart)).toMatchObject({
      _tag: "ServerRestartRequired",
      message: "server upgraded",
      threadId: "thread-1",
    })
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
        _tag: "interactive-feed-replay",
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
})
