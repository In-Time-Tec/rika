import { describe, expect, it } from "@effect/vitest"
import { Cause, Crypto, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Ref, Schema } from "effect"
import { provideLayer } from "./layer"
import {
  canonicalServiceIdentity,
  ClientMessage,
  makeLifecycle,
  protocolVersion,
  ServerMessage,
  validateHandshake,
} from "../src/resident-service"

describe("resident service protocol", () => {
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
    const base = {
      family: "rika-resident" as const,
      identity: "identity",
      token: "token",
      clientNonce: "nonce",
      clientKind: "run" as const,
      protocolVersion,
    }
    expect(validateHandshake(base, { identity: "identity", token: "token" })._tag).toBe("Accepted")
    expect(validateHandshake({ ...base, token: "wrong" }, { identity: "identity", token: "token" })._tag).toBe(
      "AuthenticationFailed",
    )
    expect(validateHandshake({ ...base, identity: "wrong" }, { identity: "identity", token: "token" })._tag).toBe(
      "IdentityMismatch",
    )
    expect(validateHandshake({ ...base, protocolVersion: 0 }, { identity: "identity", token: "token" })._tag).toBe(
      "ProtocolMismatch",
    )
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
})
