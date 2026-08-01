import { Clock, Context, Crypto, Effect, Layer, Option, Redacted } from "effect"
import * as Contract from "./openai-auth-contract"
import * as Flow from "./openai-auth-flow"

export const configuration = Flow.configuration
export const issuer = Flow.configuration.issuer
export const clientId = Flow.configuration.clientId
export const redirectUri = Flow.configuration.redirectUri
export const DeviceStartResponse = Contract.DeviceStartResponse
export const DevicePollResponse = Contract.DevicePollResponse
export const TokenResponse = Contract.TokenResponse
export const CredentialDisk = Contract.CredentialDisk
export const maxCredentialFileSize = Flow.configuration.maxCredentialFileSize
export import Presenter = Flow.Presenter
export import Host = Flow.Host
export import Http = Flow.Http
export import Store = Flow.Store
export import AuthError = Flow.Errors.AuthError
export import StoreError = Flow.Errors.StoreError
export type { StoreInterface } from "./openai-auth-flow"
export type { AuthorizationResult } from "./openai-auth-contract"

export type Credential = Contract.Credential
export type Status = Contract.Status
export type Error = Flow.Errors.AuthError | Flow.Errors.StoreError

export interface ServiceInterface {
  readonly loginBrowser: (redirect?: string) => Effect.Effect<Credential, Error>
  readonly loginDevice: Effect.Effect<Credential, Error>
  readonly status: Effect.Effect<Status, Flow.Errors.StoreError>
  readonly logout: Effect.Effect<
    { readonly removed: boolean; readonly revocationSupported: false },
    Flow.Errors.StoreError
  >
  readonly acquire: Effect.Effect<Credential, Error>
  readonly refreshRejected: (generation: string) => Effect.Effect<Credential, Error>
}
export class Service extends Context.Service<Service, ServiceInterface>()(
  "@rika/product/authentication/openai-auth-service/Service",
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

export const layer = (options: TimingOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const host = yield* Flow.Host
      const presenter = yield* Flow.Presenter
      const http = yield* Flow.Http
      const store = yield* Flow.Store
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
              return yield* Flow.Errors.AuthError.make({ kind: "login-required", message: "Login is required" })
            if (current.value.generation !== generation) {
              const separator = generation.lastIndexOf(".")
              const expectedFingerprint = separator < 0 ? undefined : generation.slice(0, separator)
              if (expectedFingerprint !== undefined && expectedFingerprint !== current.value.fingerprint) {
                return yield* Flow.Errors.AuthError.make({
                  kind: "account-mismatch",
                  message: "OpenAI account changed while the request was active; start the turn again",
                })
              }
              return publicCredential(current.value)
            }
            const response = yield* http.refresh(Redacted.make(current.value.refreshToken))
            return yield* persist(response, current.value)
          }),
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
              return yield* Flow.Errors.AuthError.make({
                kind: "protocol",
                message: "Authorization state did not match",
              })
            }
            const response = yield* http.exchange({ code: result.code, verifier: pkce.verifier, redirectUri: redirect })
            return yield* store.serialized(persist(response))
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
            return yield* Flow.Errors.AuthError.make({
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
              return yield* Flow.Errors.AuthError.make({ kind: "timeout", message: "Device authorization expired" })
            }
            const polled = yield* http
              .devicePoll(Redacted.make(start.device_auth_id), start.user_code)
              .pipe(Effect.timeoutOption(remaining))
            if (Option.isNone(polled) || (yield* Clock.currentTimeMillis) >= deadline) {
              return yield* Flow.Errors.AuthError.make({ kind: "timeout", message: "Device authorization expired" })
            }
            if (Option.isSome(polled.value)) {
              result = polled.value.value
              break
            }
          }
          const response = yield* http.exchange({
            code: Redacted.make(result.authorization_code),
            verifier: Redacted.make(result.code_verifier),
            redirectUri: Flow.configuration.deviceExchangeRedirect,
          })
          return yield* store.serialized(persist(response))
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
            return yield* Flow.Errors.AuthError.make({ kind: "login-required", message: "Login is required" })
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
