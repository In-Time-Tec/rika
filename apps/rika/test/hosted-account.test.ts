import { Cause, Clock, Context, Effect, Exit, Fiber, Layer, Option, Redacted, Ref } from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { expect, it } from "@effect/vitest"
import { pollDeviceAuthorization, status } from "../src/hosted/hosted-account"
import { layer as credentialLayer, type SecretVault } from "../src/hosted/hosted-credential-store"
import {
  CredentialStore,
  HostedError,
  Http,
  ProfileStore,
  type Credential,
  type DevicePoll,
  type HttpInterface,
  type PrivateJwk,
  type Profile,
} from "../src/hosted/hosted-contract"

const key: PrivateJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }
const profile: Profile = {
  origin: "https://hosted.example.test",
  deviceId: "device-1",
  clientId: "client-1",
  organization: "org-1",
}
const authorization = {
  deviceCode: "device-secret",
  userCode: "ABCD-EFGH",
  verificationUri: "https://hosted.example.test/device",
  expiresIn: 30,
  interval: 1,
}
const unusedHttp: HttpInterface = {
  register: () => Effect.die("unused"),
  startDeviceAuthorization: () => Effect.die("unused"),
  pollDeviceAuthorization: () => Effect.die("unused"),
  refresh: () => Effect.die("unused"),
  context: () => Effect.die("unused"),
  invite: () => Effect.die("unused"),
  devices: () => Effect.die("unused"),
  revokeDevice: () => Effect.die("unused"),
  createRemoteConnection: () => Effect.die("unused"),
  runThread: () => Effect.die("unused"),
}

it.effect("polls pending and network failures, applies RFC slow_down, and completes", () =>
  Effect.gen(function* () {
    const polls = yield* Ref.make(0)
    const http = Http.of({
      ...unusedHttp,
      pollDeviceAuthorization: () =>
        Ref.getAndUpdate(polls, (value) => value + 1).pipe(
          Effect.flatMap((attempt): Effect.Effect<DevicePoll, HostedError> => {
            if (attempt === 0) return Effect.succeed({ _tag: "Pending" as const })
            if (attempt === 1)
              return Effect.fail(HostedError.make({ kind: "network", message: "temporary network failure" }))
            if (attempt === 2) return Effect.succeed({ _tag: "SlowDown" as const })
            return Effect.succeed({
              _tag: "Complete" as const,
              tokens: { accessToken: "access", refreshToken: "refresh", expiresIn: 600 },
            })
          }),
        ),
    })
    const fiber = yield* Effect.forkChild(
      pollDeviceAuthorization(profile, key, authorization).pipe(Effect.provideService(Http, http)),
    )
    yield* TestClock.adjust("3 seconds")
    expect(yield* Ref.get(polls)).toBe(3)
    yield* TestClock.adjust("6 seconds")
    expect(yield* Fiber.join(fiber)).toEqual({ accessToken: "access", refreshToken: "refresh", expiresIn: 600 })
    expect(yield* Ref.get(polls)).toBe(4)
  }),
)

it.effect("reports denial and expiry and remains interruptible", () =>
  Effect.gen(function* () {
    const denied = yield* Effect.forkChild(
      pollDeviceAuthorization(profile, key, authorization).pipe(
        Effect.provideService(
          Http,
          Http.of({ ...unusedHttp, pollDeviceAuthorization: () => Effect.succeed({ _tag: "Denied" }) }),
        ),
      ),
    )
    yield* TestClock.adjust("1 second")
    expect((yield* Effect.flip(Fiber.join(denied))).kind).toBe("denied")
    const issuedAt = yield* Clock.currentTimeMillis
    yield* TestClock.adjust("2 seconds")
    const expired = yield* Effect.forkChild(
      pollDeviceAuthorization(profile, key, { ...authorization, expiresIn: 3 }, issuedAt).pipe(
        Effect.provideService(
          Http,
          Http.of({ ...unusedHttp, pollDeviceAuthorization: () => Effect.succeed({ _tag: "Pending" }) }),
        ),
      ),
    )
    yield* TestClock.adjust("1 second")
    expect((yield* Effect.flip(Fiber.join(expired))).kind).toBe("expired")
    const interrupted = yield* Effect.forkChild(
      pollDeviceAuthorization(profile, key, authorization).pipe(
        Effect.provideService(Http, Http.of({ ...unusedHttp, pollDeviceAuthorization: () => Effect.never })),
      ),
    )
    yield* Fiber.interrupt(interrupted)
    const exit = yield* Fiber.await(interrupted)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }),
)

it.effect("rotates the refresh token while keeping access tokens in memory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const saved = yield* Ref.make<Option.Option<Credential>>(Option.none())
      const observedAccess = yield* Ref.make<ReadonlyArray<string>>([])
      const store = CredentialStore.of({
        load: () => Effect.succeed(Option.some({ refreshToken: Redacted.make("old-refresh"), privateJwk: key })),
        save: (_origin, _device, value) => Ref.set(saved, Option.some(value)),
        remove: () => Effect.succeed(true),
      })
      const http = Http.of({
        ...unusedHttp,
        refresh: (_origin, clientId, token, privateJwk) => {
          expect(clientId).toBe("client-1")
          expect(Redacted.value(token)).toBe("old-refresh")
          expect(privateJwk).toEqual(key)
          return Effect.succeed({ accessToken: "memory-access", refreshToken: "rotated-refresh", expiresIn: 600 })
        },
        context: (_origin, session) =>
          Ref.update(observedAccess, (values) => [...values, Redacted.value(session.accessToken)]).pipe(
            Effect.as({
              account: { id: "account-1", email: "dev@example.test" },
              organizations: [{ id: "org-1", slug: "engineering", name: "Engineering" }],
            }),
          ),
      })
      const context = yield* Layer.build(
        Layer.mergeAll(
          Layer.succeed(Http, http),
          Layer.succeed(CredentialStore, store),
          Layer.succeed(
            ProfileStore,
            ProfileStore.of({ load: Effect.succeed(Option.some(profile)), save: () => Effect.void }),
          ),
          TestConsole.layer,
        ),
      )
      yield* status(true).pipe(Effect.provide(context))
      expect(Redacted.value(Option.getOrThrow(yield* Ref.get(saved)).refreshToken)).toBe("rotated-refresh")
      expect(yield* Ref.get(observedAccess)).toEqual(["memory-access"])
      expect((yield* TestConsole.logLines).join("\n")).toContain('"authenticated":true')
    }),
  ),
)

it.effect("uses Bun secrets and fails closed when platform credential storage is unavailable", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const values = new Map<string, string>()
      const vault: SecretVault = {
        get: ({ service, name }) => Promise.resolve(values.get(`${service}:${name}`) ?? null),
        set: ({ service, name, value }) => {
          values.set(`${service}:${name}`, value)
          return Promise.resolve()
        },
        delete: ({ service, name }) => Promise.resolve(values.delete(`${service}:${name}`)),
      }
      const context = yield* Layer.build(credentialLayer(vault))
      const store = Context.get(context, CredentialStore)
      const credential = { refreshToken: Redacted.make("refresh"), privateJwk: key }
      yield* store.save(profile.origin, profile.deviceId, credential)
      expect(Redacted.value(Option.getOrThrow(yield* store.load(profile.origin, profile.deviceId)).refreshToken)).toBe(
        "refresh",
      )
      const unavailable: SecretVault = {
        get: () => Promise.reject(new Error("no secret service")),
        set: () => Promise.reject(new Error("no secret service")),
        delete: () => Promise.reject(new Error("no secret service")),
      }
      const unavailableContext = yield* Layer.build(credentialLayer(unavailable))
      const unavailableStore = Context.get(unavailableContext, CredentialStore)
      expect((yield* Effect.flip(unavailableStore.save(profile.origin, profile.deviceId, credential))).kind).toBe(
        "storage",
      )
      expect((yield* Effect.flip(unavailableStore.load(profile.origin, profile.deviceId))).kind).toBe("storage")
      expect((yield* Effect.flip(unavailableStore.remove(profile.origin, profile.deviceId))).kind).toBe("storage")
    }),
  ),
)
