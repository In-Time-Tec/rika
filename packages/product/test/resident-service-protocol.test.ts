import { describe, expect, it } from "@effect/vitest"
import { Crypto, Effect, Layer, Runtime, Schema } from "effect"
import { provideLayer } from "./product-test-layer"
import * as ResidentHandshake from "../src/resident/resident-service-handshake"
import * as ResidentService from "../src/resident/resident-service"

describe("resident service protocol", () => {
  it("supersedes only an idle resident for a launching client", () => {
    expect(
      ResidentHandshake.HandshakeProtocol.replacementDisposition({
        connectRole: "launch",
        hasActiveExecutionWork: false,
      }),
    ).toBe("supersede")
    expect(
      ResidentHandshake.HandshakeProtocol.replacementDisposition({
        connectRole: "launch",
        hasActiveExecutionWork: true,
      }),
    ).toBe("defer")
    expect(
      ResidentHandshake.HandshakeProtocol.replacementDisposition({
        connectRole: "reattach",
        hasActiveExecutionWork: false,
      }),
    ).toBe("restart")
    expect(
      ResidentHandshake.HandshakeProtocol.replacementDisposition({
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
      ResidentService.ServiceRuntime.canonicalServiceIdentity(profile, "/tmp/rika").pipe(provideLayer(crypto))
    return Effect.gen(function* () {
      expect(yield* identity("default")).toBe(yield* identity("default"))
      expect(yield* identity("other")).not.toBe(yield* identity("default"))
    })
  })

  it("fails closed for token and identity mismatches", () => {
    const unsigned = {
      family: "rika-resident" as const,
      identity: "identity",
      clientNonce: "nonce",
      clientKind: "run" as const,
      connectRole: "launch" as const,
      protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
      buildIdentity: "build-a",
    }
    const base = { ...unsigned, clientProof: ResidentHandshake.HandshakeProtocol.clientProof("token", unsigned) }
    expect(
      ResidentHandshake.HandshakeProtocol.validateHandshake(base, {
        identity: "identity",
        token: "token",
        buildIdentity: "build-a",
      })._tag,
    ).toBe("Accepted")
    expect(
      ResidentHandshake.HandshakeProtocol.validateHandshake(
        { ...base, clientProof: ResidentHandshake.HandshakeProtocol.clientProof("wrong", unsigned) },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("AuthenticationFailed")
    expect(
      ResidentHandshake.HandshakeProtocol.validateHandshake(
        { ...base, identity: "wrong" },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("IdentityMismatch")
    expect(
      ResidentHandshake.HandshakeProtocol.validateHandshake(
        {
          ...base,
          protocolVersion: 0,
          clientProof: ResidentHandshake.HandshakeProtocol.clientProof("token", { ...unsigned, protocolVersion: 0 }),
        },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("ProtocolMismatch")
    expect(
      ResidentHandshake.HandshakeProtocol.validateHandshake(
        {
          ...base,
          buildIdentity: "build-b",
          clientProof: ResidentHandshake.HandshakeProtocol.clientProof("token", {
            ...unsigned,
            buildIdentity: "build-b",
          }),
        },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("BuildMismatch")
    const reattachUnsigned = { ...unsigned, connectRole: "reattach" as const, buildIdentity: "build-b" }
    expect(
      ResidentHandshake.HandshakeProtocol.validateHandshake(
        {
          ...reattachUnsigned,
          clientProof: ResidentHandshake.HandshakeProtocol.clientProof("token", reattachUnsigned),
        },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("Accepted")
    expect(
      ResidentHandshake.HandshakeProtocol.validateHandshake(
        { ...base, connectRole: "reattach" },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("AuthenticationFailed")
    expect(
      ResidentHandshake.HandshakeProtocol.validateHandshake(
        { ...base, protocolVersion: 0, buildIdentity: "build-b" },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("AuthenticationFailed")
  })

  it("requires an explicit protocol version and bounded non-empty transport identities", () => {
    const base = {
      family: "rika-resident",
      identity: "identity",
      clientNonce: "nonce",
      clientKind: "run",
      clientProof: "0".repeat(64),
    }
    expect(() => Schema.decodeUnknownSync(ResidentService.ClientMessage)(base)).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ResidentService.ClientMessage)({
        ...base,
        protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ResidentService.ClientMessage)({
        ...base,
        protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "build-a",
        clientNonce: "",
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ResidentService.ClientMessage)({
        ...base,
        protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "build-a",
        identity: "x".repeat(1_025),
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ResidentService.ClientMessage)({
        ...base,
        protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "x".repeat(1_025),
      }),
    ).toThrow()
    for (const connectRole of ["launch", "reattach"])
      expect(
        Schema.decodeUnknownSync(ResidentService.ClientMessage)({
          ...base,
          connectRole,
          protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
          buildIdentity: "build-a",
        }),
      ).toMatchObject({ connectRole })
  })

  it("authenticates the resident response and binds both nonces and the connection identity", () => {
    const handshake = {
      identity: "identity",
      clientNonce: "client-nonce",
      clientKind: "run" as const,
      connectRole: "launch" as const,
      protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
      buildIdentity: "build-a",
    }
    const accepted = Schema.decodeUnknownSync(ResidentService.ServerMessage)({
      _tag: "accepted",
      family: "rika-resident",
      identity: handshake.identity,
      clientNonce: handshake.clientNonce,
      serviceNonce: "service-nonce",
      connectionId: "connection",
      protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
      buildIdentity: "build-a",
      serverProof: ResidentHandshake.HandshakeProtocol.serverProof("token", handshake, {
        _tag: "accepted",
        family: "rika-resident",
        identity: handshake.identity,
        clientNonce: handshake.clientNonce,
        serviceNonce: "service-nonce",
        connectionId: "connection",
        protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "build-a",
      }),
    })
    expect(accepted._tag).toBe("accepted")
    if (accepted._tag !== "accepted") return
    expect(ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, accepted)).toBe(true)
    expect(ResidentHandshake.HandshakeProtocol.verifyServerProof("wrong", handshake, accepted)).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof(
        "token",
        { ...handshake, clientNonce: "reflected" },
        accepted,
      ),
    ).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...accepted,
        connectionId: "foreign",
      }),
    ).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...accepted,
        buildIdentity: "build-b",
      }),
    ).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...accepted,
        protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion + 1,
      }),
    ).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...accepted,
        serviceNonce: "foreign",
      }),
    ).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, { ...accepted, residentPid: 42 }),
    ).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof(
        "token",
        { ...handshake, connectRole: "reattach" },
        accepted,
      ),
    ).toBe(false)

    const incompatibleFields = {
      _tag: "incompatible" as const,
      disposition: "supersede" as const,
      replacementGuard: ResidentHandshake.HandshakeProtocol.replacementGuard,
      family: "rika-resident" as const,
      identity: handshake.identity,
      clientNonce: handshake.clientNonce,
      serviceNonce: "service-nonce",
      connectionId: "connection",
      protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
      buildIdentity: "build-b",
      residentPid: 123,
    }
    const incompatible = Schema.decodeUnknownSync(ResidentService.ServerMessage)({
      ...incompatibleFields,
      serverProof: ResidentHandshake.HandshakeProtocol.serverProof("token", handshake, incompatibleFields),
    })
    expect(incompatible._tag).toBe("incompatible")
    if (incompatible._tag !== "incompatible") return
    expect(ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, incompatible)).toBe(true)
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...incompatible,
        disposition: "restart",
      }),
    ).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...incompatible,
        disposition: "defer",
      }),
    ).toBe(false)
    expect(() =>
      Schema.decodeUnknownSync(ResidentService.ServerMessage)({ ...incompatible, replacementGuard: "unattested" }),
    ).toThrow()
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, { ...incompatible, residentPid: 124 }),
    ).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.verifyServerProof("token", handshake, {
        ...incompatible,
        connectionId: "other",
      }),
    ).toBe(false)
  })

  it("accepts only incompatibility responses justified by the connection role", () => {
    expect(
      ResidentHandshake.HandshakeProtocol.isValidIncompatibility("launch", {
        protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "other-build",
      }),
    ).toBe(true)
    expect(
      ResidentHandshake.HandshakeProtocol.isValidIncompatibility("launch", {
        protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "rika-development-build",
      }),
    ).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.isValidIncompatibility("reattach", {
        protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
        buildIdentity: "other-build",
      }),
    ).toBe(false)
    expect(
      ResidentHandshake.HandshakeProtocol.isValidIncompatibility("reattach", {
        protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion - 1,
        buildIdentity: "rika-development-build",
      }),
    ).toBe(true)
  })

  it("round-trips empty and semantic transcript pages without undefined wire fields", () => {
    const message = Schema.decodeUnknownSync(ResidentService.ServerMessage)({
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
    const encoded = Schema.encodeSync(ResidentService.ServerMessage)(message)
    const wire = Schema.encodeSync(Schema.UnknownFromJsonString)(encoded)
    expect(wire).not.toContain("oldestCursor")
    expect(
      Schema.decodeUnknownSync(ResidentService.ServerMessage)(Schema.decodeSync(Schema.UnknownFromJsonString)(wire)),
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
      const decoded = Schema.decodeUnknownSync(ResidentService.ClientMessage)(input)
      expect(
        Schema.decodeUnknownSync(ResidentService.ClientMessage)(
          Schema.encodeSync(ResidentService.ClientMessage)(decoded),
        ),
      ).toEqual(decoded)
    }
    expect(() =>
      Schema.decodeUnknownSync(ResidentService.ClientMessage)({
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
    expect(ResidentService.ServiceRuntime.runtimeRestartExitCode).toBe(75)
    const restart = ResidentService.ResidentRestartRequired.make({ message: "resident upgraded", threadId: "thread-1" })
    expect(restart[Runtime.errorExitCode]).toBe(ResidentService.ServiceRuntime.runtimeRestartExitCode)
    expect(Schema.is(ResidentService.ResidentRestartRequired)(restart)).toBe(true)
    const decoded = Schema.decodeUnknownSync(ResidentService.ResidentRestartRequired)({
      _tag: "ResidentRestartRequired",
      message: "resident upgraded",
    })
    expect(decoded.threadId).toBeUndefined()
    expect(Schema.encodeSync(ResidentService.ResidentRestartRequired)(restart)).toMatchObject({
      _tag: "ResidentRestartRequired",
      message: "resident upgraded",
      threadId: "thread-1",
    })
  })

  it("rejects sequence values outside the current resident contract", () => {
    const client = {
      connectionId: "connection",
      requestId: "request",
      sessionId: "session",
      feedGeneration: "feed",
    }
    expect(() =>
      Schema.decodeUnknownSync(ResidentService.ClientMessage)({
        _tag: "interactive-command",
        ...client,
        commandSequence: 0,
        command: { _tag: "Cancel" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ResidentService.ClientMessage)({
        _tag: "interactive-feed-ack",
        ...client,
        throughSequence: 0,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ResidentService.ClientMessage)({
        _tag: "interactive-feed-replay",
        ...client,
        afterSequence: -1,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ResidentService.ServerMessage)({
        _tag: "interactive-started",
        ...client,
        feedCapacity: 0,
      }),
    ).toThrow()
  })
})
