import { Cause, Clock, Effect, Exit, Fiber, Layer, Option, Redacted, Ref } from "effect"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { TestClock, TestConsole } from "effect/testing"
import { expect, it } from "@effect/vitest"
import { login, pollDeviceAuthorization } from "../../../src/hosted/account"
import {
  Browser,
  CredentialStore,
  HostedError,
  Http,
  ProfileStore,
  type Credential,
  type DevicePoll,
  type Profile,
} from "../../../src/hosted/contract"
import { authorization, key, profile, unusedHttp } from "./fixture"

it.effect("defaults a first login with zero organizations to Personal", () =>
  Effect.gen(function* () {
    const savedProfile = yield* Ref.make<Option.Option<Profile>>(Option.none())
    const savedCredential = yield* Ref.make<Option.Option<Credential>>(Option.none())
    const context = yield* Layer.build(
      Layer.mergeAll(
        BunCrypto.layer,
        Layer.succeed(
          ProfileStore,
          ProfileStore.of({
            load: Effect.succeed(Option.none()),
            save: (value) => Ref.set(savedProfile, Option.some(value)),
          }),
        ),
        Layer.succeed(
          CredentialStore,
          CredentialStore.of({
            load: () => Effect.succeed(Option.none()),
            save: (_origin, _device, value) => Ref.set(savedCredential, Option.some(value)),
            remove: () => Effect.succeed(false),
            serialized: (effect) => effect,
          }),
        ),
        Layer.succeed(
          Http,
          Http.of({
            ...unusedHttp,
            register: () => Effect.succeed({ clientId: "client-personal" }),
            startDeviceAuthorization: () => Effect.succeed({ ...authorization, interval: 0 }),
            pollDeviceAuthorization: () =>
              Effect.succeed({
                _tag: "Complete",
                tokens: { accessToken: "access", refreshToken: "refresh", expiresIn: 600 },
              }),
            context: () =>
              Effect.succeed({
                account: { id: "user-1", email: "dev@example.test", name: "Dev" },
                organizations: [],
                projects: [],
              }),
          }),
        ),
        Layer.succeed(Browser, Browser.of({ open: () => Effect.die("unused") })),
        TestConsole.layer,
      ),
    )
    yield* login({ server: profile.origin, noOpen: true }).pipe(Effect.provide(context))
    expect(Option.getOrThrow(yield* Ref.get(savedProfile))).toMatchObject({
      origin: profile.origin,
      clientId: "client-personal",
      owner: { kind: "personal" },
    })
    const credential = Option.getOrThrow(yield* Ref.get(savedCredential))
    expect(credential.accessToken === undefined ? undefined : Redacted.value(credential.accessToken)).toBe("access")
    expect(credential.accessTokenExpiresAt).toBe(600_000)
  }),
)

it.effect("re-registers when the saved OAuth client no longer exists", () =>
  Effect.gen(function* () {
    const savedProfile = yield* Ref.make<Option.Option<Profile>>(Option.none())
    const savedCredential = yield* Ref.make<Option.Option<Credential>>(Option.none())
    const revoked = yield* Ref.make<ReadonlyArray<string>>([])
    const registrations = yield* Ref.make(0)
    const starts = yield* Ref.make<ReadonlyArray<string>>([])
    const context = yield* Layer.build(
      Layer.mergeAll(
        BunCrypto.layer,
        Layer.succeed(
          ProfileStore,
          ProfileStore.of({
            load: Effect.succeed(Option.some(profile)),
            save: (value) => Ref.set(savedProfile, Option.some(value)),
          }),
        ),
        Layer.succeed(
          CredentialStore,
          CredentialStore.of({
            load: () => Effect.succeed(Option.some({ refreshToken: Redacted.make("stale-refresh"), privateJwk: key })),
            save: (_origin, _device, value) => Ref.set(savedCredential, Option.some(value)),
            remove: () => Effect.succeed(false),
            serialized: (effect) => effect,
          }),
        ),
        Layer.succeed(
          Http,
          Http.of({
            ...unusedHttp,
            register: () => Ref.update(registrations, (value) => value + 1).pipe(Effect.as({ clientId: "client-2" })),
            startDeviceAuthorization: (_origin, clientId) =>
              Ref.update(starts, (current) => [...current, clientId]).pipe(
                Effect.flatMap(() =>
                  clientId === profile.clientId
                    ? Effect.fail(
                        HostedError.make({
                          kind: "registration-required",
                          message: "CLI registration is no longer valid",
                        }),
                      )
                    : Effect.succeed({ ...authorization, interval: 0 }),
                ),
              ),
            pollDeviceAuthorization: () =>
              Effect.succeed({
                _tag: "Complete",
                tokens: { accessToken: "access", refreshToken: "refresh", expiresIn: 600 },
              }),
            context: () =>
              Effect.succeed({
                account: { id: "user-1", email: "dev@example.test", name: "Dev" },
                organizations: [{ id: "org-1", slug: "engineering", name: "Engineering", logo: null }],
                projects: [],
              }),
            revokeDevice: (_origin, deviceId) =>
              Ref.update(revoked, (current) => [...current, deviceId]).pipe(
                Effect.andThen(
                  Effect.fail(HostedError.make({ kind: "network", message: "device revocation unavailable" })),
                ),
              ),
          }),
        ),
        Layer.succeed(Browser, Browser.of({ open: () => Effect.die("unused") })),
        TestConsole.layer,
      ),
    )
    yield* login({ server: profile.origin, noOpen: true }).pipe(Effect.provide(context))
    expect(yield* Ref.get(registrations)).toBe(1)
    expect(yield* Ref.get(starts)).toEqual(["client-1", "client-2"])
    expect(yield* Ref.get(revoked)).toEqual(["device-1"])
    expect(Option.getOrThrow(yield* Ref.get(savedProfile))).toMatchObject({
      origin: profile.origin,
      clientId: "client-2",
      owner: profile.owner,
    })
    expect(Option.isSome(yield* Ref.get(savedCredential))).toBe(true)
    expect(yield* TestConsole.logLines.pipe(Effect.provide(context))).toContain(
      "Previous CLI device device-1 could not be revoked: device revocation unavailable\nRun rika auth revoke-device device-1 to revoke it",
    )
  }),
)

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
