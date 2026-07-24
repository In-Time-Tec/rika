import { describe, expect, it } from "@effect/vitest"
import { Cause, Crypto, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Ref, Runtime, Schema } from "effect"
import { provideLayer } from "./layer"
import {
  canonicalServiceIdentity,
  clientProof,
  ClientMessage,
  isValidIncompatibility,
  makeLifecycle,
  protocolVersion,
  replacementGuard,
  replacementDisposition,
  ResidentRestartRequired,
  runtimeRestartExitCode,
  ServerMessage,
  serverProof,
  validateHandshake,
  verifyServerProof,
} from "../src/resident-service"

describe("resident service protocol", () => {
  it("supersedes only an idle resident for a launching client", () => {
    expect(replacementDisposition({ connectRole: "launch", hasActiveExecutionWork: false })).toBe("supersede")
    expect(replacementDisposition({ connectRole: "launch", hasActiveExecutionWork: true })).toBe("defer")
    expect(replacementDisposition({ connectRole: "reattach", hasActiveExecutionWork: false })).toBe("restart")
    expect(replacementDisposition({ connectRole: "reattach", hasActiveExecutionWork: true })).toBe("restart")
  })

  it.effect("uses canonical profile and data root identity", () => {
    const crypto = Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    )
    const identity = (profile: string) => canonicalServiceIdentity(profile, "/tmp/rika").pipe(provideLayer(crypto))
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
      protocolVersion,
      buildIdentity: "build-a",
    }
    const base = { ...unsigned, clientProof: clientProof("token", unsigned) }
    expect(validateHandshake(base, { identity: "identity", token: "token", buildIdentity: "build-a" })._tag).toBe(
      "Accepted",
    )
    expect(
      validateHandshake(
        { ...base, clientProof: clientProof("wrong", unsigned) },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("AuthenticationFailed")
    expect(
      validateHandshake(
        { ...base, identity: "wrong" },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("IdentityMismatch")
    expect(
      validateHandshake(
        {
          ...base,
          protocolVersion: 0,
          clientProof: clientProof("token", { ...unsigned, protocolVersion: 0 }),
        },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("ProtocolMismatch")
    expect(
      validateHandshake(
        {
          ...base,
          buildIdentity: "build-b",
          clientProof: clientProof("token", { ...unsigned, buildIdentity: "build-b" }),
        },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("BuildMismatch")
    const reattachUnsigned = { ...unsigned, connectRole: "reattach" as const, buildIdentity: "build-b" }
    expect(
      validateHandshake(
        { ...reattachUnsigned, clientProof: clientProof("token", reattachUnsigned) },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("Accepted")
    expect(
      validateHandshake(
        { ...base, connectRole: "reattach" },
        { identity: "identity", token: "token", buildIdentity: "build-a" },
      )._tag,
    ).toBe("AuthenticationFailed")
    expect(
      validateHandshake(
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
    expect(() => Schema.decodeUnknownSync(ClientMessage)(base)).toThrow()
    expect(() => Schema.decodeUnknownSync(ClientMessage)({ ...base, protocolVersion })).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ClientMessage)({ ...base, protocolVersion, buildIdentity: "build-a", clientNonce: "" }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ClientMessage)({
        ...base,
        protocolVersion,
        buildIdentity: "build-a",
        identity: "x".repeat(1_025),
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ClientMessage)({ ...base, protocolVersion, buildIdentity: "x".repeat(1_025) }),
    ).toThrow()
    for (const connectRole of ["launch", "reattach"])
      expect(
        Schema.decodeUnknownSync(ClientMessage)({
          ...base,
          connectRole,
          protocolVersion,
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
      protocolVersion,
      buildIdentity: "build-a",
    }
    const accepted = Schema.decodeUnknownSync(ServerMessage)({
      _tag: "accepted",
      family: "rika-resident",
      identity: handshake.identity,
      clientNonce: handshake.clientNonce,
      serviceNonce: "service-nonce",
      connectionId: "connection",
      protocolVersion,
      buildIdentity: "build-a",
      serverProof: serverProof("token", handshake, {
        _tag: "accepted",
        family: "rika-resident",
        identity: handshake.identity,
        clientNonce: handshake.clientNonce,
        serviceNonce: "service-nonce",
        connectionId: "connection",
        protocolVersion,
        buildIdentity: "build-a",
      }),
    })
    expect(accepted._tag).toBe("accepted")
    if (accepted._tag !== "accepted") return
    expect(verifyServerProof("token", handshake, accepted)).toBe(true)
    expect(verifyServerProof("wrong", handshake, accepted)).toBe(false)
    expect(verifyServerProof("token", { ...handshake, clientNonce: "reflected" }, accepted)).toBe(false)
    expect(verifyServerProof("token", handshake, { ...accepted, connectionId: "foreign" })).toBe(false)
    expect(verifyServerProof("token", handshake, { ...accepted, buildIdentity: "build-b" })).toBe(false)
    expect(verifyServerProof("token", handshake, { ...accepted, protocolVersion: protocolVersion + 1 })).toBe(false)
    expect(verifyServerProof("token", handshake, { ...accepted, serviceNonce: "foreign" })).toBe(false)
    expect(verifyServerProof("token", handshake, { ...accepted, residentPid: 42 })).toBe(false)
    expect(verifyServerProof("token", { ...handshake, connectRole: "reattach" }, accepted)).toBe(false)

    const incompatibleFields = {
      _tag: "incompatible" as const,
      disposition: "supersede" as const,
      replacementGuard,
      family: "rika-resident" as const,
      identity: handshake.identity,
      clientNonce: handshake.clientNonce,
      serviceNonce: "service-nonce",
      connectionId: "connection",
      protocolVersion,
      buildIdentity: "build-b",
      residentPid: 123,
    }
    const incompatible = Schema.decodeUnknownSync(ServerMessage)({
      ...incompatibleFields,
      serverProof: serverProof("token", handshake, incompatibleFields),
    })
    expect(incompatible._tag).toBe("incompatible")
    if (incompatible._tag !== "incompatible") return
    expect(verifyServerProof("token", handshake, incompatible)).toBe(true)
    expect(verifyServerProof("token", handshake, { ...incompatible, disposition: "restart" })).toBe(false)
    expect(verifyServerProof("token", handshake, { ...incompatible, disposition: "defer" })).toBe(false)
    expect(() => Schema.decodeUnknownSync(ServerMessage)({ ...incompatible, replacementGuard: "unattested" })).toThrow()
    expect(verifyServerProof("token", handshake, { ...incompatible, residentPid: 124 })).toBe(false)
    expect(verifyServerProof("token", handshake, { ...incompatible, connectionId: "other" })).toBe(false)
  })

  it("accepts only incompatibility responses justified by the connection role", () => {
    expect(isValidIncompatibility("launch", { protocolVersion, buildIdentity: "other-build" })).toBe(true)
    expect(isValidIncompatibility("launch", { protocolVersion, buildIdentity: "rika-development-build" })).toBe(false)
    expect(isValidIncompatibility("reattach", { protocolVersion, buildIdentity: "other-build" })).toBe(false)
    expect(
      isValidIncompatibility("reattach", {
        protocolVersion: protocolVersion - 1,
        buildIdentity: "rika-development-build",
      }),
    ).toBe(true)
  })

  it("round-trips empty and semantic transcript pages without undefined wire fields", () => {
    const message = Schema.decodeUnknownSync(ServerMessage)({
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
    const encoded = Schema.encodeSync(ServerMessage)(message)
    const wire = Schema.encodeSync(Schema.UnknownFromJsonString)(encoded)
    expect(wire).not.toContain("oldestCursor")
    expect(Schema.decodeUnknownSync(ServerMessage)(Schema.decodeSync(Schema.UnknownFromJsonString)(wire))).toEqual(
      message,
    )
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
      { _tag: "ResolvePermission", waitId: "wait", kind: "permission", decision: "always" },
      { _tag: "NewThread" },
      { _tag: "SelectThread", threadId: "thread", selectionEpoch: 3 },
      { _tag: "ReadQueue", threadId: "thread" },
      { _tag: "LoadOlder" },
      { _tag: "PreviewThread", threadId: "thread" },
      { _tag: "ReopenThread", selectionEpoch: 4 },
      { _tag: "Replay", turnId: "turn", afterCursor: "cursor" },
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
      const decoded = Schema.decodeUnknownSync(ClientMessage)(input)
      expect(Schema.decodeUnknownSync(ClientMessage)(Schema.encodeSync(ClientMessage)(decoded))).toEqual(decoded)
    }
    expect(() =>
      Schema.decodeUnknownSync(ClientMessage)({
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
    expect(runtimeRestartExitCode).toBe(75)
    const restart = ResidentRestartRequired.make({ message: "resident upgraded", threadId: "thread-1" })
    expect(restart[Runtime.errorExitCode]).toBe(runtimeRestartExitCode)
    expect(Schema.is(ResidentRestartRequired)(restart)).toBe(true)
    const decoded = Schema.decodeUnknownSync(ResidentRestartRequired)({
      _tag: "ResidentRestartRequired",
      message: "resident upgraded",
    })
    expect(decoded.threadId).toBeUndefined()
    expect(Schema.encodeSync(ResidentRestartRequired)(restart)).toMatchObject({
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
      Schema.decodeUnknownSync(ClientMessage)({
        _tag: "interactive-command",
        ...client,
        commandSequence: 0,
        command: { _tag: "Cancel" },
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ClientMessage)({
        _tag: "interactive-feed-ack",
        ...client,
        throughSequence: 0,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ClientMessage)({
        _tag: "interactive-feed-replay",
        ...client,
        afterSequence: -1,
      }),
    ).toThrow()
    expect(() =>
      Schema.decodeUnknownSync(ServerMessage)({
        _tag: "interactive-started",
        ...client,
        feedCapacity: 0,
      }),
    ).toThrow()
  })
})

describe("resident service lifecycle", () => {
  it("cancels grace when another authenticated client attaches", () =>
    Effect.gen(function* () {
      const states = yield* Effect.gen(function* () {
        const observed = yield* Ref.make<Array<string>>([])
        const lifecycle = yield* makeLifecycle((state) => Ref.update(observed, (values) => [...values, state]))
        yield* lifecycle.tryAttach
        yield* lifecycle.ready
        yield* lifecycle.detach
        yield* lifecycle.tryAttach
        return yield* Ref.get(observed)
      }).pipe(Effect.withSpan("ResidentService.test"))
      expect(states).toEqual(["ready", "grace", "ready"])
    }))

  it("drains only after the final client grace expires", () =>
    Effect.gen(function* () {
      const state = yield* Effect.gen(function* () {
        const lifecycle = yield* makeLifecycle(() => Effect.void)
        yield* lifecycle.tryAttach
        yield* lifecycle.tryAttach
        yield* lifecycle.ready
        yield* lifecycle.detach
        yield* lifecycle.expireGrace(0)
        expect(yield* lifecycle.state).toBe("ready")
        const generation = yield* lifecycle.detach
        expect(generation).toBeDefined()
        yield* lifecycle.expireGrace(generation!)
        return yield* lifecycle.state
      }).pipe(Effect.withSpan("ResidentService.test"))
      expect(state).toBe("draining")
    }))

  it("does not let a stale grace timer stop a reattached service", () =>
    Effect.gen(function* () {
      const state = yield* Effect.gen(function* () {
        const lifecycle = yield* makeLifecycle(() => Effect.void)
        yield* lifecycle.tryAttach
        yield* lifecycle.ready
        const stale = yield* lifecycle.detach
        yield* lifecycle.tryAttach
        yield* lifecycle.detach
        expect(yield* lifecycle.expireGrace(stale!)).toBe(false)
        return yield* lifecycle.state
      }).pipe(Effect.withSpan("ResidentService.test"))
      expect(state).toBe("grace")
    }))

  it("never admits a client after draining starts", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const lifecycle = yield* makeLifecycle(() => Effect.void)
        expect(yield* lifecycle.tryAttach).toBe(true)
        yield* lifecycle.ready
        const generation = yield* lifecycle.detach
        expect(yield* lifecycle.expireGrace(generation!)).toBe(true)
        const attached = yield* lifecycle.tryAttach
        yield* lifecycle.ready
        return { attached, state: yield* lifecycle.state }
      }).pipe(Effect.withSpan("ResidentService.test"))
      expect(result).toEqual({ attached: false, state: "draining" })
    }))

  it("begins cooperative drain monotonically", () =>
    Effect.gen(function* () {
      const result = yield* Effect.gen(function* () {
        const lifecycle = yield* makeLifecycle(() => Effect.void)
        expect(yield* lifecycle.tryAttach).toBe(true)
        yield* lifecycle.ready
        yield* lifecycle.beginDrain
        yield* lifecycle.ready
        return { attached: yield* lifecycle.tryAttach, state: yield* lifecycle.state }
      }).pipe(Effect.withSpan("ResidentService.test"))
      expect(result).toEqual({ attached: false, state: "draining" })
    }))

  it("never reports ready after draining starts", () =>
    Effect.gen(function* () {
      const observed = yield* Ref.make<Array<string>>([])
      const lifecycle = yield* makeLifecycle((state) => Ref.update(observed, (states) => [...states, state]))
      yield* lifecycle.tryAttach
      yield* lifecycle.ready
      yield* lifecycle.beginDrain
      yield* lifecycle.ready
      yield* lifecycle.stopped
      yield* lifecycle.ready
      expect(yield* Ref.get(observed)).toEqual(["ready", "draining", "stopped"])
    }))

  it("atomically rejects work once draining starts", () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* makeLifecycle(() => Effect.void)
          const fibers = yield* FiberSet.make<void>()
          yield* lifecycle.ready
          yield* lifecycle.beginDrain
          const fiber = yield* lifecycle.runWork(fibers, Effect.void)
          return { admitted: fiber !== undefined, size: yield* FiberSet.size(fibers) }
        }),
      )
      expect(result).toEqual({ admitted: false, size: 0 })
    }))

  it("serializes work admission with drain and lets the host interrupt accepted work", () =>
    Effect.gen(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const lifecycle = yield* makeLifecycle(() => Effect.void)
          const fibers = yield* FiberSet.make<void>()
          const started = yield* Deferred.make<void>()
          const finalized = yield* Deferred.make<void>()
          yield* lifecycle.ready
          const fiber = yield* lifecycle.runWork(
            fibers,
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(finalized, undefined)),
            ),
          )
          expect(fiber).toBeDefined()
          yield* Deferred.await(started)
          yield* lifecycle.beginDrain
          yield* FiberSet.clear(fibers)
          yield* FiberSet.awaitEmpty(fibers)
          const exit = yield* Fiber.await(fiber!)
          return {
            interrupted: Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause),
            finalized: yield* Deferred.isDone(finalized),
            admittedAfterDrain: (yield* lifecycle.runWork(fibers, Effect.void)) !== undefined,
          }
        }),
      )
      expect(result).toEqual({ interrupted: true, finalized: true, admittedAfterDrain: false })
    }))

  it("keeps work admission closed after an idle replacement decision", () =>
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(() => Effect.void)
      const inspectionStarted = yield* Deferred.make<void>()
      const finishInspection = yield* Deferred.make<void>()
      yield* lifecycle.ready
      const decision = yield* Effect.forkChild(
        lifecycle.authorizeReplacement(
          Deferred.succeed(inspectionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishInspection)),
            Effect.as(false),
          ),
        ),
      )
      yield* Deferred.await(inspectionStarted)
      const admissionCompleted = yield* Deferred.make<void>()
      const admission = yield* Effect.forkChild(
        lifecycle.reserveReplacementWork.pipe(Effect.tap(() => Deferred.succeed(admissionCompleted, undefined))),
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(admissionCompleted)).toBe(false)
      yield* Deferred.succeed(finishInspection, undefined)
      expect(yield* Fiber.join(decision)).toBe("supersede")
      expect(yield* Fiber.join(admission)).toBeUndefined()
      expect(yield* lifecycle.state).toBe("draining")
    }))

  it("blocks attachment during replacement inspection and refuses it after authorization", () =>
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(() => Effect.void)
      const inspectionStarted = yield* Deferred.make<void>()
      const finishInspection = yield* Deferred.make<void>()
      yield* lifecycle.ready
      const decision = yield* Effect.forkChild(
        lifecycle.authorizeReplacement(
          Deferred.succeed(inspectionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishInspection)),
            Effect.as(false),
          ),
        ),
      )
      yield* Deferred.await(inspectionStarted)
      const attachCompleted = yield* Deferred.make<void>()
      const attachment = yield* Effect.forkChild(
        lifecycle.tryAttach.pipe(Effect.tap(() => Deferred.succeed(attachCompleted, undefined))),
      )
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(attachCompleted)).toBe(false)
      yield* Deferred.succeed(finishInspection, undefined)
      expect(yield* Fiber.join(decision)).toBe("supersede")
      expect(yield* Fiber.join(attachment)).toBe(false)
    }))

  it("defers for admitted work, leaves the resident usable, and authorizes retry after release", () =>
    Effect.gen(function* () {
      const lifecycle = yield* makeLifecycle(() => Effect.void)
      yield* lifecycle.ready
      const release = yield* lifecycle.reserveReplacementWork
      expect(release).toBeDefined()
      expect(yield* lifecycle.authorizeReplacement(Effect.succeed(false))).toBe("defer")
      expect(yield* lifecycle.state).not.toBe("draining")
      yield* release!
      const next = yield* lifecycle.reserveReplacementWork
      expect(next).toBeDefined()
      yield* next!
      expect(yield* lifecycle.authorizeReplacement(Effect.succeed(false))).toBe("supersede")
      expect(yield* lifecycle.state).toBe("draining")
    }))
})
