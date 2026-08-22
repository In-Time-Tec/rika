import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import * as BunPath from "@effect/platform-bun/BunPath"
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Redacted,
  Ref,
} from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { expect, it } from "@effect/vitest"
import {
  authenticated,
  createRemoteThread,
  listOrganizations,
  login,
  logout,
  logoutAll,
  pollDeviceAuthorization,
  status,
  useOrganization,
  usePersonalOwner,
} from "../src/hosted/hosted-account"
import { layer as credentialLayer, type SecretVault } from "../src/hosted/hosted-credential-store"
import {
  Browser,
  CredentialStore,
  HostedError,
  Http,
  ProfileStore,
  ThreadClient,
  type Credential,
  type DevicePoll,
  type HttpInterface,
  type PrivateJwk,
  type Profile,
} from "../src/hosted/hosted-contract"

const platform = Layer.mergeAll(BunFileSystem.layer, BunPath.layer)
const key: PrivateJwk = { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" }
const profile: Profile = {
  origin: "https://hosted.example.test",
  deviceId: "device-1",
  clientId: "client-1",
  owner: { kind: "organization", organizationId: "org-1" },
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
  revokeAllDevices: () => Effect.die("unused"),
  issueThreadTicket: () => Effect.die("unused"),
  registerLocalRunner: () => Effect.die("unused"),
  setRemoteThreadCreation: () => Effect.die("unused"),
  pollLocalRunner: () => Effect.die("unused"),
  putProviderCredential: () => Effect.die("unused"),
  listProviderCredentials: () => Effect.die("unused"),
  revokeProviderCredential: () => Effect.die("unused"),
}

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
    expect(Option.isSome(yield* Ref.get(savedCredential))).toBe(true)
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

it.effect("rotates the refresh token while keeping access tokens in memory", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const saved = yield* Ref.make<Option.Option<Credential>>(Option.none())
      const observedAccess = yield* Ref.make<ReadonlyArray<string>>([])
      const store = CredentialStore.of({
        load: () => Effect.succeed(Option.some({ refreshToken: Redacted.make("old-refresh"), privateJwk: key })),
        save: (_origin, _device, value) => Ref.set(saved, Option.some(value)),
        remove: () => Effect.succeed(true),
        serialized: (effect) => effect,
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
              account: { id: "account-1", email: "dev@example.test", name: "Dev" },
              organizations: [{ id: "org-1", slug: "engineering", name: "Engineering", logo: null }],
              projects: [],
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

it.layer(platform)((test) => {
  test.effect("serializes rotating refresh tokens across independent credential stores", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-hosted-refresh-" })
        const values = new Map<string, string>()
        const vault: SecretVault = {
          get: ({ service, name }) => Promise.resolve(values.get(`${service}:${name}`) ?? null),
          set: ({ service, name, value }) => {
            values.set(`${service}:${name}`, value)
            return Promise.resolve()
          },
          delete: ({ service, name }) => Promise.resolve(values.delete(`${service}:${name}`)),
        }
        const lockPath = path.join(root, "refresh.lock")
        const first = Context.get(
          yield* Layer.build(credentialLayer({ vault, lockPath, lockRetry: 0 })),
          CredentialStore,
        )
        const second = Context.get(
          yield* Layer.build(credentialLayer({ vault, lockPath, lockRetry: 0 })),
          CredentialStore,
        )
        yield* first.save(profile.origin, profile.deviceId, {
          refreshToken: Redacted.make("refresh-0"),
          privateJwk: key,
        })
        let serverToken = "refresh-0"
        let revision = 0
        const firstRefresh = yield* Deferred.make<void>()
        const releaseFirstRefresh = yield* Deferred.make<void>()
        const http = Http.of({
          ...unusedHttp,
          refresh: (_origin, _client, token) =>
            Effect.gen(function* () {
              const presented = Redacted.value(token)
              if (presented !== serverToken)
                return yield* HostedError.make({ kind: "denied", message: "refresh token was already rotated" })
              if (revision === 0) {
                yield* Deferred.succeed(firstRefresh, undefined)
                yield* Deferred.await(releaseFirstRefresh)
              }
              if (presented !== serverToken)
                return yield* HostedError.make({ kind: "denied", message: "refresh token was already rotated" })
              revision += 1
              serverToken = `refresh-${revision}`
              return { accessToken: `access-${revision}`, refreshToken: serverToken, expiresIn: 600 }
            }),
        })
        const authenticate = (store: CredentialStore["Service"]) =>
          authenticated(profile, (session) => Effect.succeed(Redacted.value(session.accessToken))).pipe(
            Effect.provideService(CredentialStore, store),
            Effect.provideService(Http, http),
          )
        const firstFiber = yield* Effect.forkChild(authenticate(first))
        yield* Deferred.await(firstRefresh)
        const secondFiber = yield* Effect.forkChild(authenticate(second))
        yield* Effect.yieldNow
        yield* Deferred.succeed(releaseFirstRefresh, undefined)
        expect((yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)])).toSorted()).toEqual([
          "access-1",
          "access-2",
        ])
        expect(
          Redacted.value(Option.getOrThrow(yield* first.load(profile.origin, profile.deviceId)).refreshToken),
        ).toBe("refresh-2")
      }),
    ),
  )

  test.effect("uses Bun secrets and fails closed when platform credential storage is unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-hosted-vault-" })
        const values = new Map<string, string>()
        const vault: SecretVault = {
          get: ({ service, name }) => Promise.resolve(values.get(`${service}:${name}`) ?? null),
          set: ({ service, name, value }) => {
            values.set(`${service}:${name}`, value)
            return Promise.resolve()
          },
          delete: ({ service, name }) => Promise.resolve(values.delete(`${service}:${name}`)),
        }
        const context = yield* Layer.build(credentialLayer({ vault, lockPath: path.join(root, "refresh.lock") }))
        const store = Context.get(context, CredentialStore)
        const credential = { refreshToken: Redacted.make("refresh"), privateJwk: key }
        yield* store.save(profile.origin, profile.deviceId, credential)
        expect(
          Redacted.value(Option.getOrThrow(yield* store.load(profile.origin, profile.deviceId)).refreshToken),
        ).toBe("refresh")
        const unavailable: SecretVault = {
          get: () => Promise.reject(new Error("no secret service")),
          set: () => Promise.reject(new Error("no secret service")),
          delete: () => Promise.reject(new Error("no secret service")),
        }
        const unavailableContext = yield* Layer.build(
          credentialLayer({ vault: unavailable, lockPath: path.join(root, "unavailable-refresh.lock") }),
        )
        const unavailableStore = Context.get(unavailableContext, CredentialStore)
        expect((yield* Effect.flip(unavailableStore.save(profile.origin, profile.deviceId, credential))).kind).toBe(
          "storage",
        )
        expect((yield* Effect.flip(unavailableStore.load(profile.origin, profile.deviceId))).kind).toBe("storage")
        expect((yield* Effect.flip(unavailableStore.remove(profile.origin, profile.deviceId))).kind).toBe("storage")
      }),
    ),
  )
})

it.effect("keeps local credentials when all-device revocation fails so retry can complete", () =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0)
    const removed = yield* Ref.make(0)
    const store = CredentialStore.of({
      load: () => Effect.succeed(Option.some({ refreshToken: Redacted.make("old-refresh"), privateJwk: key })),
      save: () => Effect.void,
      remove: () => Ref.update(removed, (value) => value + 1).pipe(Effect.as(true)),
      serialized: (effect) => effect,
    })
    const http = Http.of({
      ...unusedHttp,
      refresh: () => Effect.succeed({ accessToken: "access", refreshToken: "refresh", expiresIn: 600 }),
      revokeAllDevices: () =>
        Ref.getAndUpdate(attempts, (value) => value + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 0
              ? Effect.fail(HostedError.make({ kind: "network", message: "temporary outage" }))
              : Effect.void,
          ),
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
    const first = yield* Effect.exit(logoutAll().pipe(Effect.provide(context)))
    expect(first._tag).toBe("Failure")
    expect(yield* Ref.get(removed)).toBe(0)
    yield* logoutAll().pipe(Effect.provide(context))
    expect(yield* Ref.get(removed)).toBe(1)
  }),
)

it.effect("treats logout as idempotent before a profile exists", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      Layer.mergeAll(
        Layer.succeed(Http, Http.of(unusedHttp)),
        Layer.succeed(
          CredentialStore,
          CredentialStore.of({
            load: () => Effect.die("unused"),
            save: () => Effect.die("unused"),
            remove: () => Effect.die("unused"),
            serialized: (effect) => effect,
          }),
        ),
        Layer.succeed(ProfileStore, ProfileStore.of({ load: Effect.succeed(Option.none()), save: () => Effect.void })),
        TestConsole.layer,
      ),
    )
    yield* logout().pipe(Effect.provide(context))
    yield* logoutAll().pipe(Effect.provide(context))
    expect(yield* TestConsole.logLines.pipe(Effect.provide(context))).toEqual(["Not logged in", "Not logged in"])
  }),
)

it.effect("lists Personal, switches owners, clears projects, and returns to Personal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const current = yield* Ref.make<Profile>({ ...profile, owner: { kind: "personal" }, project: "project-1" })
      const context = yield* Layer.build(
        Layer.mergeAll(
          Layer.succeed(
            ProfileStore,
            ProfileStore.of({
              load: Ref.get(current).pipe(Effect.map(Option.some)),
              save: (value) => Ref.set(current, value),
            }),
          ),
          Layer.succeed(
            CredentialStore,
            CredentialStore.of({
              load: () => Effect.succeed(Option.some({ refreshToken: Redacted.make("refresh"), privateJwk: key })),
              save: () => Effect.void,
              remove: () => Effect.succeed(true),
              serialized: (effect) => effect,
            }),
          ),
          Layer.succeed(
            Http,
            Http.of({
              ...unusedHttp,
              refresh: () => Effect.succeed({ accessToken: "access", refreshToken: "refresh", expiresIn: 600 }),
              context: () =>
                Effect.succeed({
                  account: { id: "user-1", email: "dev@example.test", name: "Dev" },
                  organizations: [{ id: "org-1", slug: "engineering", name: "Engineering", logo: null }],
                  projects: [],
                }),
            }),
          ),
          TestConsole.layer,
        ),
      )
      yield* listOrganizations().pipe(Effect.provide(context))
      expect(yield* TestConsole.logLines.pipe(Effect.provide(context))).toEqual([
        "* Personal",
        "  Engineering (engineering)",
      ])
      yield* useOrganization("engineering").pipe(Effect.provide(context))
      expect(yield* Ref.get(current)).toEqual({ ...profile, owner: { kind: "organization", organizationId: "org-1" } })
      yield* usePersonalOwner().pipe(Effect.provide(context))
      expect(yield* Ref.get(current)).toEqual({ ...profile, owner: { kind: "personal" } })
    }),
  ),
)

it.effect("creates for Personal with zero organizations and fails closed for a stale organization", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make<Profile>({ ...profile, owner: { kind: "personal" } })
    const created = yield* Ref.make(0)
    const context = yield* Layer.build(
      Layer.mergeAll(
        Layer.succeed(
          ProfileStore,
          ProfileStore.of({
            load: Ref.get(current).pipe(Effect.map(Option.some)),
            save: (value) => Ref.set(current, value),
          }),
        ),
        Layer.succeed(
          CredentialStore,
          CredentialStore.of({
            load: () => Effect.succeed(Option.some({ refreshToken: Redacted.make("refresh"), privateJwk: key })),
            save: () => Effect.void,
            remove: () => Effect.succeed(true),
            serialized: (effect) => effect,
          }),
        ),
        Layer.succeed(
          Http,
          Http.of({
            ...unusedHttp,
            refresh: () => Effect.succeed({ accessToken: "access", refreshToken: "refresh", expiresIn: 600 }),
            context: () =>
              Effect.succeed({
                account: { id: "user-1", email: "dev@example.test", name: "Dev" },
                organizations: [],
                projects: [],
              }),
            issueThreadTicket: () =>
              Effect.succeed({
                ticket: "ticket-1",
                expiresAt: "2026-08-21T06:00:00.000Z" as never,
                websocketUrl: "wss://hosted.example.test/api/v1/threads/socket",
                protocol: "rika.thread.v1",
              }),
          }),
        ),
        Layer.succeed(
          ThreadClient,
          ThreadClient.of({
            create: ({ owner }) => {
              expect(owner).toEqual({ kind: "personal" })
              return Ref.update(created, (value) => value + 1).pipe(Effect.as("thread-1" as never))
            },
            submit: () => Effect.die("unused"),
          }),
        ),
        BunCrypto.layer,
        TestConsole.layer,
      ),
    )
    yield* createRemoteThread().pipe(Effect.provide(context))
    yield* Ref.set(current, { ...profile, owner: { kind: "organization", organizationId: "revoked" } })
    const error = yield* Effect.flip(createRemoteThread().pipe(Effect.provide(context)))
    expect(error.message).toContain("rika org personal")
    expect(yield* Ref.get(created)).toBe(1)
  }),
)
