import { Clock, Context, Crypto, Effect, Layer, Option, Redacted } from "effect"
import * as Contract from "./openai-contract"
import * as Flow from "./openai-flow"

interface AuthorizationResult {
  readonly code: Redacted.Redacted<string>
  readonly state: Redacted.Redacted<string>
}
interface DevicePrompt {
  readonly verificationUrl: string
  readonly userCode: string
  readonly warning: string
}
interface HostInterface {
  readonly authorize: (
    url: URL,
    expectedState: Redacted.Redacted<string>,
  ) => Effect.Effect<AuthorizationResult, Contract.AuthError>
}
export class Host extends Context.Service<Host, HostInterface>()(
  "@rika/product/authentication/openai-service/Host",
) {}
interface PresenterInterface {
  readonly device: (prompt: DevicePrompt) => Effect.Effect<void, Contract.AuthError>
}
export class Presenter extends Context.Service<Presenter, PresenterInterface>()(
  "@rika/product/authentication/openai-service/Presenter",
) {}
interface HttpInterface {
  readonly exchange: (input: {
    readonly code: Redacted.Redacted<string>
    readonly verifier: Redacted.Redacted<string>
    readonly redirectUri: string
  }) => Effect.Effect<typeof Contract.TokenResponse.Type, Contract.AuthError>
  readonly refresh: (
    refreshToken: Redacted.Redacted<string>,
  ) => Effect.Effect<typeof Contract.TokenResponse.Type, Contract.AuthError>
  readonly deviceStart: Effect.Effect<typeof Contract.DeviceStartResponse.Type, Contract.AuthError>
  readonly devicePoll: (
    deviceAuthId: Redacted.Redacted<string>,
    userCode: string,
  ) => Effect.Effect<Option.Option<typeof Contract.DevicePollResponse.Type>, Contract.AuthError>
}
export class Http extends Context.Service<Http, HttpInterface>()(
  "@rika/product/authentication/openai-service/Http",
) {}
interface StoreInterface {
  readonly load: Effect.Effect<Option.Option<typeof Contract.CredentialDisk.Type>, Contract.StoreError>
  readonly save: (credential: typeof Contract.CredentialDisk.Type) => Effect.Effect<void, Contract.StoreError>
  readonly remove: Effect.Effect<boolean, Contract.StoreError>
  readonly serialized: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Contract.StoreError, R>
}
export class Store extends Context.Service<Store, StoreInterface>()(
  "@rika/product/authentication/openai-service/Store",
) {}

type Credential = Contract.Credential
type Status = Contract.Status
type Error = Contract.AuthError | Contract.StoreError

export interface ServiceInterface {
  readonly loginBrowser: (redirect?: string) => Effect.Effect<Credential, Error>
  readonly loginDevice: Effect.Effect<Credential, Error>
  readonly status: Effect.Effect<Status, Contract.StoreError>
  readonly logout: Effect.Effect<
    { readonly removed: boolean; readonly revocationSupported: false },
    Contract.StoreError
  >
  readonly acquire: Effect.Effect<Credential, Error>
  readonly refreshRejected: (generation: string) => Effect.Effect<Credential, Error>
}
export class Service extends Context.Service<Service, ServiceInterface>()(
  "@rika/product/authentication/openai-service/Service",
) {}

interface TimingOptions {
  readonly deviceTimeout?: number
}

const publicCredential = (value: typeof Contract.CredentialDisk.Type): Credential => ({
  accessToken: Redacted.make(value.accessToken),
  idToken: Redacted.make(value.idToken),
  refreshToken: Redacted.make(value.refreshToken),
  accountId: Redacted.make(value.accountId),
  fingerprint: value.fingerprint,
  generation: value.generation,
  expiresAt: value.expiresAt,
  refreshedAt: value.refreshedAt,
})

export const configuration = Flow.configuration

export const layer = (options: TimingOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const host = yield* Host
      const presenter = yield* Presenter
      const http = yield* Http
      const store = yield* Store
      const crypto = yield* Crypto.Crypto
      const persist = (response: typeof Contract.TokenResponse.Type, previous?: typeof Contract.CredentialDisk.Type) =>
        Effect.gen(function* () {
          const value = yield* Flow.Flow.credentialFrom(crypto, response, previous)
          yield* store.save(value)
          return publicCredential(value)
        })
      const refreshGeneration = (generation: string) =>
        store.serialized(
          Effect.gen(function* () {
            const current = yield* store.load
            if (Option.isNone(current))
              return yield* Contract.AuthError.make({ kind: "login-required", message: "Login is required" })
            if (current.value.generation !== generation) {
              const separator = generation.lastIndexOf(".")
              const expectedFingerprint = separator < 0 ? undefined : generation.slice(0, separator)
              if (expectedFingerprint !== undefined && expectedFingerprint !== current.value.fingerprint) {
                return yield* Contract.AuthError.make({
                  kind: "account-mismatch",
                  message: "OpenAI account changed while the request was active; start the turn again",
                })
              }
              return publicCredential(current.value)
            }
            return yield* Effect.uninterruptibleMask((restore) =>
              restore(http.refresh(Redacted.make(current.value.refreshToken))).pipe(
                Effect.flatMap((response) => persist(response, current.value)),
              ),
            )
          }),
        )
      const exchangeAndPersist = (exchange: Effect.Effect<typeof Contract.TokenResponse.Type, Contract.AuthError>) =>
        Effect.uninterruptibleMask((restore) =>
          restore(exchange).pipe(Effect.flatMap((response) => store.serialized(persist(response)))),
        )
      const service: ServiceInterface = {
        loginBrowser: (redirect = Flow.configuration.redirectUri) =>
          Effect.gen(function* () {
            const pkce = yield* Flow.Flow.makePkce.pipe(Effect.provideService(Crypto.Crypto, crypto))
            const result = yield* host.authorize(
              Flow.Flow.authorizationUrl(pkce.challenge, pkce.state, redirect),
              pkce.state,
            )
            if (Redacted.value(result.state) !== Redacted.value(pkce.state)) {
              return yield* Contract.AuthError.make({
                kind: "protocol",
                message: "Authorization state did not match",
              })
            }
            return yield* exchangeAndPersist(
              http.exchange({ code: result.code, verifier: pkce.verifier, redirectUri: redirect }),
            )
          }),
        loginDevice: Effect.gen(function* () {
          const start = yield* http.deviceStart
          yield* presenter.device({
            verificationUrl: Flow.configuration.deviceVerificationUrl,
            userCode: start.user_code,
            warning:
              "Continue only if you started this login in Rika. If a website or another person gave you this code, cancel.",
          })
          const normalizedInterval = start.interval.trim()
          const interval = /^\d+$/.test(normalizedInterval) ? Number(normalizedInterval) : Number.NaN
          if (!Number.isSafeInteger(interval) || interval < 1) {
            return yield* Contract.AuthError.make({
              kind: "protocol",
              message: "Device authorization interval is invalid",
            })
          }
          const deadline = (yield* Clock.currentTimeMillis) + (options.deviceTimeout ?? 900_000)
          let result: typeof Contract.DevicePollResponse.Type
          while (true) {
            yield* Effect.sleep(`${interval} seconds`)
            const remaining = deadline - (yield* Clock.currentTimeMillis)
            if (remaining <= 0) {
              return yield* Contract.AuthError.make({ kind: "timeout", message: "Device authorization expired" })
            }
            const polled = yield* http
              .devicePoll(Redacted.make(start.device_auth_id), start.user_code)
              .pipe(Effect.timeoutOption(remaining))
            if (Option.isNone(polled) || (yield* Clock.currentTimeMillis) >= deadline) {
              return yield* Contract.AuthError.make({ kind: "timeout", message: "Device authorization expired" })
            }
            if (Option.isSome(polled.value)) {
              result = polled.value.value
              break
            }
          }
          return yield* exchangeAndPersist(
            http.exchange({
              code: Redacted.make(result.authorization_code),
              verifier: Redacted.make(result.code_verifier),
              redirectUri: Flow.configuration.deviceExchangeRedirect,
            }),
          )
        }),
        status: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          return yield* store.load.pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                error.kind === "corrupt" ? Effect.succeed<Status>({ _tag: "Corrupt" }) : Effect.fail(error),
              onSuccess: (entry) => {
                if (Option.isNone(entry)) return Effect.succeed<Status>({ _tag: "Unauthenticated" })
                if (entry.value.expiresAt <= now + 300_000) {
                  return Effect.succeed<Status>({ _tag: "RefreshRequired", fingerprint: entry.value.fingerprint })
                }
                return Effect.succeed<Status>({ _tag: "Present", fingerprint: entry.value.fingerprint })
              },
            }),
          )
        }),
        logout: store
          .serialized(store.remove)
          .pipe(Effect.map((removed) => ({ removed, revocationSupported: false as const }))),
        acquire: Effect.gen(function* () {
          const entry = yield* store.load
          if (Option.isNone(entry))
            return yield* Contract.AuthError.make({ kind: "login-required", message: "Login is required" })
          const now = yield* Clock.currentTimeMillis
          return entry.value.expiresAt <= now + 300_000
            ? yield* refreshGeneration(entry.value.generation)
            : publicCredential(entry.value)
        }),
        refreshRejected: refreshGeneration,
      }
      return Service.of(service)
    }),
  )
