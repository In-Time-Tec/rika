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
  Schema,
} from "effect"
import { TestClock, TestConsole } from "effect/testing"
import { expect, it } from "@effect/vitest"
import {
  authenticated,
  createRemoteThread,
  getOpenAiAccount,
  listOrganizations,
  login,
  logout,
  logoutAll,
  pollDeviceAuthorization,
  putOpenAiAccount,
  revokeOpenAiAccount,
  status,
  useOrganization,
  usePersonalOwner,
} from "../../src/hosted/account"
import { layer as credentialLayer } from "../../src/hosted/credential-store"
import {
  Browser,
  CredentialStore,
  HostedError,
  HostedThreadId,
  Http,
  ProfileStore,
  ThreadClient,
  type Credential,
  type DevicePoll,
  type HttpInterface,
  type PrivateJwk,
  type Profile,
} from "../../src/hosted/contract"
import { ClientTicketResponse } from "@rika/product/client-protocol"

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
  registerRunner: () => Effect.die("unused"),
  setRemoteThreadCreation: () => Effect.die("unused"),
  pollRunner: () => Effect.die("unused"),
  putProviderCredential: () => Effect.die("unused"),
  listProviderCredentials: () => Effect.die("unused"),
  revokeProviderCredential: () => Effect.die("unused"),
  putOpenAiAccount: () => Effect.die("unused"),
  getOpenAiAccount: () => Effect.die("unused"),
  revokeOpenAiAccount: () => Effect.die("unused"),
  createProject: () => Effect.die("unused"),
  putEnvironment: () => Effect.die("unused"),
  revokeEnvironment: () => Effect.die("unused"),
  publishRepository: () => Effect.die("unused"),
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
    const credential = Option.getOrThrow(yield* Ref.get(savedCredential))
    expect(credential.accessToken === undefined ? undefined : Redacted.value(credential.accessToken)).toBe("access")
    expect(credential.accessTokenExpiresAt).toBe(600_000)
  }),
)

it.effect("stores, reads, and revokes the OpenAI account for the selected hosted owner", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<{ readonly action: string; readonly owner: unknown }>>([])
    const account = {
      accessToken: Redacted.make("oauth-access"),
      idToken: Redacted.make("oauth-id"),
      refreshToken: Redacted.make("oauth-refresh"),
      accountId: Redacted.make("account-id"),
      fingerprint: "fingerprint-1",
      generation: "fingerprint-1.generation-1",
      expiresAt: Number.MAX_SAFE_INTEGER,
      refreshedAt: 0,
    }
    const active = {
      state: "active" as const,
      revision: "1",
      credentialIdentity: "openai-account-1",
      fingerprint: account.fingerprint,
    }
    const context = yield* Layer.build(
      Layer.mergeAll(
        Layer.succeed(
          ProfileStore,
          ProfileStore.of({ load: Effect.succeed(Option.some(profile)), save: () => Effect.void }),
        ),
        Layer.succeed(
          CredentialStore,
          CredentialStore.of({
            load: () =>
              Effect.succeed(
                Option.some({
                  refreshToken: Redacted.make("refresh"),
                  privateJwk: key,
                  accessToken: Redacted.make("access"),
                  accessTokenExpiresAt: 600_000,
                }),
              ),
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
            putOpenAiAccount: (_origin, owner, credential) =>
              Ref.update(calls, (values) => [...values, { action: "put", owner }]).pipe(
                Effect.tap(() => Effect.sync(() => expect(credential).toBe(account))),
                Effect.as(active),
              ),
            getOpenAiAccount: (_origin, owner) =>
              Ref.update(calls, (values) => [...values, { action: "status", owner }]).pipe(Effect.as(active)),
            revokeOpenAiAccount: (_origin, owner) =>
              Ref.update(calls, (values) => [...values, { action: "revoke", owner }]).pipe(
                Effect.as({ ...active, state: "revoked" as const, revision: "2" }),
              ),
          }),
        ),
        TestConsole.layer,
      ),
    )
    yield* putOpenAiAccount(account).pipe(Effect.provide(context))
    yield* getOpenAiAccount().pipe(Effect.provide(context))
    yield* revokeOpenAiAccount().pipe(Effect.provide(context))
    expect(yield* Ref.get(calls)).toEqual([
      { action: "put", owner: profile.owner },
      { action: "status", owner: profile.owner },
      { action: "revoke", owner: profile.owner },
    ])
    expect(yield* TestConsole.logLines.pipe(Effect.provide(context))).toEqual([
      "OpenAI account is active",
      "OpenAI account is active",
      "OpenAI account logged out",
    ])
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

it.effect("migrates a legacy refresh credential to one persisted token snapshot", () =>
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

it.effect("reuses a valid access token without refreshing", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([])
    const credential: Credential = {
      refreshToken: Redacted.make("refresh"),
      privateJwk: key,
      accessToken: Redacted.make("persisted-access"),
      accessTokenExpiresAt: 600_000,
    }
    const store = CredentialStore.of({
      load: () => Effect.succeed(Option.some(credential)),
      save: () => Effect.die("unused"),
      remove: () => Effect.succeed(true),
      serialized: () => Effect.die("unused"),
    })
    const http = Http.of({ ...unusedHttp, refresh: () => Effect.die("unused") })
    const use = authenticated(profile, (session) =>
      Ref.update(calls, (values) => [...values, Redacted.value(session.accessToken)]),
    ).pipe(Effect.provideService(CredentialStore, store), Effect.provideService(Http, http))
    yield* use
    yield* use
    expect(yield* Ref.get(calls)).toEqual(["persisted-access", "persisted-access"])
  }),
)

it.effect("refreshes once and retries a protected request once after a 401", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make<Credential>({
      refreshToken: Redacted.make("refresh-0"),
      privateJwk: key,
      accessToken: Redacted.make("access-0"),
      accessTokenExpiresAt: 600_000,
    })
    const refreshes = yield* Ref.make(0)
    const requests = yield* Ref.make<ReadonlyArray<string>>([])
    const store = CredentialStore.of({
      load: () => Ref.get(current).pipe(Effect.map(Option.some)),
      save: (_origin, _device, credential) => Ref.set(current, credential),
      remove: () => Effect.succeed(true),
      serialized: (effect) => effect,
    })
    const http = Http.of({
      ...unusedHttp,
      refresh: () =>
        Ref.update(refreshes, (value) => value + 1).pipe(
          Effect.as({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 600 }),
        ),
    })
    const result = yield* authenticated(profile, (session) => {
      const accessToken = Redacted.value(session.accessToken)
      return Ref.update(requests, (values) => [...values, accessToken]).pipe(
        Effect.andThen(
          accessToken === "access-0"
            ? Effect.fail(HostedError.make({ kind: "login-required", message: "Identity login is required" }))
            : Effect.succeed("ok"),
        ),
      )
    }).pipe(Effect.provideService(CredentialStore, store), Effect.provideService(Http, http))

    expect(result).toBe("ok")
    expect(yield* Ref.get(refreshes)).toBe(1)
    expect(yield* Ref.get(requests)).toEqual(["access-0", "access-1"])
  }),
)

it.effect("stops after one protected-request retry when the replacement token also receives a 401", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make<Credential>({
      refreshToken: Redacted.make("refresh-0"),
      privateJwk: key,
      accessToken: Redacted.make("access-0"),
      accessTokenExpiresAt: 600_000,
    })
    const refreshes = yield* Ref.make(0)
    const requests = yield* Ref.make(0)
    const store = CredentialStore.of({
      load: () => Ref.get(current).pipe(Effect.map(Option.some)),
      save: (_origin, _device, credential) => Ref.set(current, credential),
      remove: () => Effect.succeed(true),
      serialized: (effect) => effect,
    })
    const http = Http.of({
      ...unusedHttp,
      refresh: () =>
        Ref.update(refreshes, (value) => value + 1).pipe(
          Effect.as({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 600 }),
        ),
    })
    const error = yield* Effect.flip(
      authenticated(profile, () =>
        Ref.update(requests, (value) => value + 1).pipe(
          Effect.andThen(HostedError.make({ kind: "login-required", message: "Identity login is required" })),
        ),
      ).pipe(Effect.provideService(CredentialStore, store), Effect.provideService(Http, http)),
    )

    expect(error.kind).toBe("login-required")
    expect(yield* Ref.get(refreshes)).toBe(1)
    expect(yield* Ref.get(requests)).toBe(2)
  }),
)

it.layer(platform)((test) => {
  test.effect("shares one refreshed access token across independent credential stores", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-hosted-refresh-" })
        const filename = path.join(root, "hosted-credential.json")
        const lockPath = path.join(root, "refresh.lock")
        const first = Context.get(
          yield* Layer.build(credentialLayer({ filename, lockPath, lockRetry: 0 })),
          CredentialStore,
        )
        const second = Context.get(
          yield* Layer.build(credentialLayer({ filename, lockPath, lockRetry: 0 })),
          CredentialStore,
        )
        yield* first.save(profile.origin, profile.deviceId, {
          refreshToken: Redacted.make("refresh-0"),
          privateJwk: key,
          accessToken: Redacted.make("expired-access"),
          accessTokenExpiresAt: 1,
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
        expect(yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)])).toEqual([
          "access-1",
          "access-1",
        ])
        expect(
          Redacted.value(Option.getOrThrow(yield* first.load(profile.origin, profile.deviceId)).refreshToken),
        ).toBe("refresh-1")
        expect(revision).toBe(1)
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
              load: () =>
                Effect.succeed(
                  Option.some({
                    refreshToken: Redacted.make("refresh"),
                    privateJwk: key,
                    accessToken: Redacted.make("access"),
                    accessTokenExpiresAt: 600_000,
                  }),
                ),
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
              Effect.succeed(
                Schema.decodeSync(ClientTicketResponse)({
                  ticket: "ticket-1",
                  expiresAt: "2026-08-21T06:00:00.000Z",
                  websocketUrl: "wss://hosted.example.test/api/v1/threads/socket",
                  protocol: "rika.thread.v1",
                }),
              ),
          }),
        ),
        Layer.succeed(
          ThreadClient,
          ThreadClient.of({
            create: ({ owner }) => {
              expect(owner).toEqual({ kind: "personal" })
              return Ref.update(created, (value) => value + 1).pipe(Effect.as(HostedThreadId.make("thread-1")))
            },
            submit: () => Effect.die("unused"),
            ensureService: () => Effect.die("unused"),
            stopService: () => Effect.die("unused"),
            openPortal: () => Effect.die("unused"),
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
