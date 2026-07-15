import { describe, expect, it } from "@effect/vitest"
import { Cause, Crypto, Deferred, Effect, Exit, Fiber, FiberSet, Layer, Ref, Schema } from "effect"
import { provideLayer } from "./layer"
import {
  canonicalServiceIdentity,
  isCurrentProtocolVersion,
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

  it("fails closed for token, identity, exact version, and capability mismatches", () => {
    const base = {
      family: "rika-resident" as const,
      version: protocolVersion,
      identity: "identity",
      token: "token",
      clientNonce: "nonce",
      clientKind: "run" as const,
      clientVersion: "1",
      capabilities: ["ping", "startup-state", "transcript-pages", "interactive-ack"] as const,
    }
    expect(validateHandshake(base, { identity: "identity", token: "token" })._tag).toBe("Accepted")
    expect(validateHandshake({ ...base, token: "wrong" }, { identity: "identity", token: "token" })._tag).toBe(
      "AuthenticationFailed",
    )
    expect(validateHandshake({ ...base, identity: "wrong" }, { identity: "identity", token: "token" })._tag).toBe(
      "IdentityMismatch",
    )
    expect(
      validateHandshake({ ...base, version: { major: 2, minor: 0 } }, { identity: "identity", token: "token" })._tag,
    ).toBe("UpgradeRequired")
    expect(
      validateHandshake(
        { ...base, capabilities: ["ping", "startup-state", "interactive-ack"] },
        { identity: "identity", token: "token", capabilities: base.capabilities },
      )._tag,
    ).toBe("CapabilityMismatch")
    expect(isCurrentProtocolVersion(protocolVersion)).toBe(true)
    expect(isCurrentProtocolVersion({ major: 1, minor: 1 })).toBe(false)
  })

  it("round-trips empty and semantic transcript pages without undefined wire fields", () => {
    const message = Schema.decodeUnknownSync(ServerMessage)({
      _tag: "interactive-event",
      version: protocolVersion,
      requestId: "request",
      sessionId: "session",
      actionId: "action",
      deliveryId: "delivery",
      event: {
        _tag: "TranscriptPageReceived",
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
      },
    })
    const encoded = Schema.encodeSync(ServerMessage)(message)
    const wire = Schema.encodeSync(Schema.UnknownFromJsonString)(encoded)
    expect(wire).not.toContain("oldestCursor")
    expect(Schema.decodeUnknownSync(ServerMessage)(Schema.decodeSync(Schema.UnknownFromJsonString)(wire))).toEqual(
      message,
    )
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
