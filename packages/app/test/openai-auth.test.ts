import { describe, expect, it } from "@effect/vitest"
import {
  Cause,
  Context,
  Crypto,
  Effect,
  Encoding,
  Exit,
  Fiber,
  Function,
  Layer,
  Option,
  Redacted,
  Schema,
  Semaphore,
} from "effect"
import { createHash } from "node:crypto"
import { TestClock } from "effect/testing"
import {
  AuthError,
  authorizationUrl,
  clientId,
  credentialFormatVersion,
  deviceExchangeRedirect,
  deviceVerificationUrl,
  Host,
  Http,
  makePkce,
  originator,
  Presenter,
  redirectUri,
  scopes,
  Service,
  Store,
  StoreError,
  TokenResponse,
  layer,
} from "../src/openai-auth"

const digest = (_algorithm: string, data: Uint8Array) =>
  Effect.promise(() => globalThis.crypto.subtle.digest("SHA-256", data).then((value) => new Uint8Array(value)))

const deterministicCrypto = (start = 0) => {
  let next = start
  return Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => Uint8Array.from({ length: size }, () => next++ & 255),
      digest,
    }),
  )
}

const jwt = (account = "account-secret", user = "user-secret", exp = 2_000_000_000) => {
  const payload = Encoding.encodeBase64Url(
    new TextEncoder().encode(
      JSON.stringify({
        exp,
        "https://api.openai.com/auth": { chatgpt_account_id: account, chatgpt_user_id: user },
      }),
    ),
  )
  return `header.${payload}.signature`
}

const expiryJwt = (exp: number) => {
  const payload = Encoding.encodeBase64Url(new TextEncoder().encode(JSON.stringify({ exp })))
  return `header.${payload}.signature`
}

const tokens = (account?: string, user?: string) => ({
  access_token: jwt(account, user),
  id_token: jwt(account, user),
  refresh_token: "refresh-secret",
  expires_in: 3600,
})

type Disk = Schema.Schema.Type<typeof import("../src/openai-auth").CredentialDisk>
const disk = (overrides: Partial<Disk> = {}): Disk => ({
  formatVersion: credentialFormatVersion,
  accessToken: jwt(),
  idToken: jwt(),
  refreshToken: "refresh-secret",
  accountId: "account-secret",
  fingerprint: createHash("sha256").update("account-secret\0user-secret").digest("base64url"),
  generation: "generation-1",
  expiresAt: 2_000_000_000_000,
  refreshedAt: 1,
  ...overrides,
})

const memoryStore = (initial: Option.Option<Disk> = Option.none()) => {
  let value = initial
  let serialized = 0
  return {
    layer: Layer.effect(
      Store,
      Effect.gen(function* () {
        const semaphore = yield* Semaphore.make(1)
        return Store.of({
          load: Effect.sync(() => value),
          save: (next) =>
            Effect.sync(() => {
              value = Option.some(next)
            }),
          remove: Effect.sync(() => {
            const removed = Option.isSome(value)
            value = Option.none()
            return removed
          }),
          serialized: (effect) =>
            semaphore.withPermits(1)(
              Effect.sync(() => {
                serialized++
              }).pipe(Effect.andThen(effect)),
            ),
        })
      }),
    ),
    value: () => value,
    serialized: () => serialized,
  }
}

const dependencies = (
  store: Layer.Layer<Store>,
  http: Http["Service"],
  host?: Host["Service"],
  presenter?: Presenter["Service"],
) =>
  layer({ deviceTimeout: 5_000 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        store,
        deterministicCrypto(),
        Layer.succeed(Http, http),
        Layer.succeed(Host, host ?? Host.of({ authorize: () => Effect.die("unused") })),
        Layer.succeed(Presenter, presenter ?? Presenter.of({ device: () => Effect.void })),
      ),
    ),
  )

const provideLayer: {
  <AOut, EOut, RIn>(
    provided: Layer.Layer<AOut, EOut, RIn>,
  ): <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | EOut, RIn | Exclude<R, AOut>>
  <A, E, R, AOut, EOut, RIn>(
    effect: Effect.Effect<A, E, R>,
    provided: Layer.Layer<AOut, EOut, RIn>,
  ): Effect.Effect<A, E | EOut, RIn | Exclude<R, AOut>>
} = Function.dual(
  2,
  <A, E, R, AOut, EOut, RIn>(effect: Effect.Effect<A, E, R>, provided: Layer.Layer<AOut, EOut, RIn>) =>
    Effect.scoped(
      Layer.build(provided).pipe(
        Effect.flatMap((context) => effect.pipe(Effect.provide(context as unknown as Context.Context<R>))),
      ),
    ),
)

const unusedHttp = Http.of({
  exchange: () => Effect.die("unused"),
  refresh: () => Effect.die("unused"),
  deviceStart: Effect.die("unused"),
  devicePoll: () => Effect.die("unused"),
})

describe("OpenAI authentication", () => {
  it.effect("creates independent deterministic PKCE values and the exact S256 challenge", () =>
    Effect.gen(function* () {
      const first = yield* makePkce
      const second = yield* makePkce
      expect(Redacted.value(first.verifier)).not.toBe(Redacted.value(first.state))
      expect(Redacted.value(first.state)).not.toBe(Redacted.value(second.state))
      const expected = Encoding.encodeBase64Url(
        new Uint8Array(
          yield* Effect.promise(() =>
            crypto.subtle.digest("SHA-256", new TextEncoder().encode(Redacted.value(first.verifier))),
          ),
        ),
      )
      expect(first.challenge).toBe(expected)
      expect(Redacted.value(first.verifier)).toHaveLength(86)
      expect(Redacted.value(first.state)).toHaveLength(43)
    }).pipe(
      Effect.provideService(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (() => {
            let next = 0
            return (size: number) => Uint8Array.from({ length: size }, () => next++ & 255)
          })(),
          digest,
        }),
      ),
    ),
  )

  it("constructs the exact Codex authorization request without exposing redacted state", () => {
    const state = Redacted.make("private-state")
    const url = authorizationUrl("challenge", state)
    expect(url.origin + url.pathname).toBe("https://auth.openai.com/oauth/authorize")
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: scopes,
      code_challenge: "challenge",
      code_challenge_method: "S256",
      state: "private-state",
      originator,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    })
    expect(String(state)).not.toContain("private-state")
  })

  it.effect("persists browser identity while returning redacted secrets and a generated fingerprint", () => {
    const store = memoryStore()
    const host = Host.of({
      authorize: (_url, state) => Effect.succeed({ code: Redacted.make("authorization-secret"), state }),
    })
    const http = Http.of({ ...unusedHttp, exchange: () => Effect.succeed(tokens()) })
    return Effect.gen(function* () {
      const service = yield* Service
      const credential = yield* service.loginBrowser()
      expect(credential.generation).toBe(Option.getOrThrow(store.value()).generation)
      expect(credential.fingerprint).toBe(Option.getOrThrow(store.value()).fingerprint)
      expect(credential.fingerprint).not.toContain("account-secret")
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(credential)).not.toContain("refresh-secret")
      expect(String(credential.accountId)).not.toContain("account-secret")
    }).pipe(provideLayer(dependencies(store.layer, http, host)))
  })

  it.effect("blocks a mismatched browser state before token exchange and redacts state/code from errors", () => {
    let exchanges = 0
    const host = Host.of({
      authorize: () =>
        Effect.succeed({ code: Redacted.make("authorization-secret"), state: Redacted.make("callback-secret") }),
    })
    const http = Http.of({
      ...unusedHttp,
      exchange: () =>
        Effect.sync(() => {
          exchanges++
          return tokens()
        }),
    })
    return Effect.gen(function* () {
      const service = yield* Service
      const exit = yield* Effect.exit(service.loginBrowser())
      expect(Exit.isFailure(exit)).toBe(true)
      expect(exchanges).toBe(0)
      expect(String(exit)).not.toContain("callback-secret")
      expect(String(exit)).not.toContain("authorization-secret")
    }).pipe(provideLayer(dependencies(memoryStore().layer, http, host)))
  })

  it.effect("preserves sanitized host cancellation and timeout errors", () => {
    const store = memoryStore()
    const run = (kind: "cancelled" | "timeout") =>
      Effect.gen(function* () {
        const service = yield* Service
        return yield* Effect.flip(service.loginBrowser())
      }).pipe(
        provideLayer(
          dependencies(
            store.layer,
            unusedHttp,
            Host.of({ authorize: () => Effect.fail(AuthError.make({ kind, message: `safe ${kind}` })) }),
          ),
        ),
      )
    return Effect.gen(function* () {
      expect((yield* run("cancelled")).kind).toBe("cancelled")
      expect((yield* run("timeout")).kind).toBe("timeout")
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(yield* run("cancelled"))).toBe(
        '{"_tag":"OpenAiAuthError","kind":"cancelled","message":"safe cancelled"}',
      )
    })
  })

  it.effect("shows the exact anti-phishing device prompt, polls pending, and uses the device redirect", () => {
    let polls = 0
    let prompt: unknown
    let exchangeRedirect = ""
    const http = Http.of({
      ...unusedHttp,
      deviceStart: Effect.succeed({ device_auth_id: "device-secret", user_code: "ABCD", interval: "1" }),
      devicePoll: () =>
        Effect.sync(() =>
          ++polls < 3
            ? Option.none()
            : Option.some({
                authorization_code: "authorization-secret",
                code_challenge: "challenge",
                code_verifier: "verifier-secret",
              }),
        ),
      exchange: (input) =>
        Effect.sync(() => {
          exchangeRedirect = input.redirectUri
          return tokens()
        }),
    })
    return Effect.gen(function* () {
      const service = yield* Service
      const fiber = yield* Effect.forkChild(service.loginDevice)
      yield* TestClock.adjust("3 seconds")
      yield* Fiber.join(fiber)
      expect(prompt).toEqual({
        verificationUrl: deviceVerificationUrl,
        userCode: "ABCD",
        warning:
          "Continue only if you started this login in Rika. If a website or another person gave you this code, cancel.",
      })
      expect(polls).toBe(3)
      expect(exchangeRedirect).toBe(deviceExchangeRedirect)
    }).pipe(
      provideLayer(
        dependencies(
          memoryStore().layer,
          http,
          undefined,
          Presenter.of({
            device: (value) =>
              Effect.sync(() => {
                prompt = value
              }),
          }),
        ),
      ),
    )
  })

  it.effect("times device login out with TestClock and remains interruptible while polling", () => {
    const http = Http.of({
      ...unusedHttp,
      deviceStart: Effect.succeed({ device_auth_id: "id", user_code: "code", interval: "1" }),
      devicePoll: () => Effect.succeed(Option.none()),
    })
    return Effect.gen(function* () {
      const service = yield* Service
      const timed = yield* Effect.forkChild(service.loginDevice)
      yield* TestClock.adjust("5 seconds")
      const error = yield* Effect.flip(Fiber.join(timed))
      expect(error.kind).toBe("timeout")
      expect(error.message).toBe("Device authorization expired")
      const cancelled = yield* Effect.forkChild(service.loginDevice)
      yield* Fiber.interrupt(cancelled)
      const cancelledExit = yield* Fiber.await(cancelled)
      expect(Exit.isFailure(cancelledExit) && Cause.hasInterruptsOnly(cancelledExit.cause)).toBe(true)
    }).pipe(provideLayer(dependencies(memoryStore().layer, http)))
  })

  it.effect("does not accept a device authorization poll that completes after expiry", () => {
    let exchanges = 0
    const http = Http.of({
      ...unusedHttp,
      deviceStart: Effect.succeed({ device_auth_id: "id", user_code: "code", interval: "1" }),
      devicePoll: () =>
        Effect.sleep("5 seconds").pipe(
          Effect.as(
            Option.some({
              authorization_code: "authorization-secret",
              code_challenge: "challenge",
              code_verifier: "verifier-secret",
            }),
          ),
        ),
      exchange: () =>
        Effect.sync(() => {
          exchanges++
          return tokens()
        }),
    })
    return Effect.gen(function* () {
      const fiber = yield* Effect.forkChild((yield* Service).loginDevice)
      yield* TestClock.adjust("6 seconds")
      const error = yield* Effect.flip(Fiber.join(fiber))
      expect(error.kind).toBe("timeout")
      expect(exchanges).toBe(0)
    }).pipe(provideLayer(dependencies(memoryStore().layer, http)))
  })

  it.effect("reports every status and does not mislabel unsafe storage as corrupt", () => {
    const status = (load: Store["Service"]["load"]) =>
      Effect.gen(function* () {
        return yield* (yield* Service).status
      }).pipe(
        provideLayer(
          dependencies(
            Layer.succeed(
              Store,
              Store.of({ load, save: () => Effect.void, remove: Effect.succeed(false), serialized: (e) => e }),
            ),
            unusedHttp,
          ),
        ),
      )
    return Effect.gen(function* () {
      expect((yield* status(Effect.succeed(Option.none())))._tag).toBe("Unauthenticated")
      expect((yield* status(Effect.succeed(Option.some(disk({ expiresAt: 0 })))))._tag).toBe("RefreshRequired")
      expect((yield* status(Effect.succeed(Option.some(disk({ expiresAt: Number.MAX_SAFE_INTEGER })))))._tag).toBe(
        "Present",
      )
      expect((yield* status(Effect.fail(StoreError.make({ kind: "corrupt", message: "safe" }))))._tag).toBe("Corrupt")
      expect((yield* Effect.flip(status(Effect.fail(StoreError.make({ kind: "unsafe", message: "safe" }))))).kind).toBe(
        "unsafe",
      )
    })
  })

  it.effect("serializes logout and returns an explicitly local-only result", () => {
    const store = memoryStore(Option.some(disk()))
    return Effect.gen(function* () {
      const result = yield* (yield* Service).logout
      expect(result).toEqual({ removed: true, revocationSupported: false })
      expect(store.serialized()).toBe(1)
    }).pipe(provideLayer(dependencies(store.layer, unusedHttp)))
  })

  it.effect("coalesces same-generation refreshes and returns current credentials for stale generations", () => {
    const store = memoryStore(Option.some(disk()))
    let refreshes = 0
    const http = Http.of({
      ...unusedHttp,
      refresh: () =>
        Effect.sync(() => {
          refreshes++
          return tokens()
        }),
    })
    return Effect.gen(function* () {
      const service = yield* Service
      const values = yield* Effect.all(
        [
          service.refreshRejected("generation-1"),
          service.refreshRejected("generation-1"),
          service.refreshRejected("generation-1"),
        ],
        { concurrency: "unbounded" },
      )
      expect(refreshes).toBe(1)
      expect(new Set(values.map((value) => value.generation)).size).toBe(1)
      const current = yield* service.refreshRejected("stale-generation")
      expect(current.generation).toBe(values[0]!.generation)
      expect(refreshes).toBe(1)
    }).pipe(provideLayer(dependencies(store.layer, http)))
  })

  it.effect("rejects a refreshed different nested identity without overwriting credentials", () => {
    const original = disk()
    const store = memoryStore(Option.some(original))
    const http = Http.of({ ...unusedHttp, refresh: () => Effect.succeed(tokens("other-account", "other-user")) })
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Service).refreshRejected(original.generation))
      expect(error.kind).toBe("account-mismatch")
      expect(Option.getOrThrow(store.value())).toEqual(original)
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(error)).not.toContain("other-account")
    }).pipe(provideLayer(dependencies(store.layer, http)))
  })

  it.effect("rejects a stale rejected generation after the stored account changes", () => {
    const firstBase = disk()
    const first = { ...firstBase, generation: `${firstBase.fingerprint}.first` }
    const secondBase = disk({
      accountId: "other-account",
      fingerprint: createHash("sha256").update("other-account\0other-user").digest("base64url"),
    })
    const second = { ...secondBase, generation: `${secondBase.fingerprint}.second` }
    const store = memoryStore(Option.some(second))
    return Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Service).refreshRejected(first.generation))
      expect(error.kind).toBe("account-mismatch")
      expect(yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(error)).not.toContain("other-account")
    }).pipe(provideLayer(dependencies(store.layer, unusedHttp)))
  })

  it.effect("uses access-token expiry without requiring identity claims in that token", () => {
    const store = memoryStore()
    const host = Host.of({
      authorize: (_url, state) => Effect.succeed({ code: Redacted.make("authorization-secret"), state }),
    })
    const http = Http.of({
      ...unusedHttp,
      exchange: () =>
        Effect.succeed({
          access_token: expiryJwt(1_900_000_000),
          id_token: jwt("account-secret", "user-secret", 1_800_000_000),
          refresh_token: "refresh-secret",
        }),
    })
    return Effect.gen(function* () {
      const credential = yield* (yield* Service).loginBrowser()
      expect(credential.expiresAt).toBe(1_900_000_000_000)
    }).pipe(provideLayer(dependencies(store.layer, http, host)))
  })

  it.effect("validates token response shape without weakening initial exchange requirements", () =>
    Effect.gen(function* () {
      expect(yield* Schema.decodeUnknownEffect(TokenResponse)({})).toEqual({})
    }),
  )
})
