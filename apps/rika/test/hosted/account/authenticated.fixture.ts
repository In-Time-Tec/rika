import { TestConsole } from "effect/testing"
import { Context, Deferred, Effect, Fiber, FileSystem, Layer, Option, Path, Redacted, Ref } from "effect"
import { expect, it } from "@effect/vitest"
import { authenticated, logout, logoutAll, status } from "../../../src/hosted/account"
import { layer as credentialLayer } from "../../../src/hosted/credential-store"
import { CredentialStore, HostedError, Http, ProfileStore, type Credential } from "../../../src/hosted/contract"
import { key, platform, profile, unusedHttp } from "./fixture"

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
        expect(yield* Effect.all([Fiber.join(firstFiber), Fiber.join(secondFiber)])).toEqual(["access-1", "access-1"])
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
