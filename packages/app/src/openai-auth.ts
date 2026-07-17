import { Clock, Context, Crypto, Effect, Encoding, Function, Layer, Option, Redacted, Result, Schema } from "effect"

export const issuer = "https://auth.openai.com"
export const clientId = "app_EMoamEEZ73f0CkXaXp7hrann"
export const redirectUri = "http://localhost:1455/auth/callback"
export const scopes = "openid profile email offline_access api.connectors.read api.connectors.invoke"
export const originator = "codex_cli_rs"
export const deviceVerificationUrl = `${issuer}/codex/device`
export const deviceExchangeRedirect = `${issuer}/deviceauth/callback`
export const credentialFormatVersion = 1
export const maxCredentialFileSize = 256 * 1024

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("OpenAiAuthError", {
  kind: Schema.Literals(["cancelled", "timeout", "host", "network", "protocol", "account-mismatch", "login-required"]),
  message: Schema.String,
}) {}

export class StoreError extends Schema.TaggedErrorClass<StoreError>()("OpenAiCredentialStoreError", {
  kind: Schema.Literals(["missing", "corrupt", "unsafe", "busy", "io"]),
  message: Schema.String,
}) {}

export type Error = AuthError | StoreError
const authError = (kind: AuthError["kind"], message: string) => AuthError.make({ kind, message })

export interface AuthorizationResult {
  readonly code: Redacted.Redacted<string>
  readonly state: Redacted.Redacted<string>
}
export interface HostInterface {
  readonly authorize: (
    url: URL,
    expectedState: Redacted.Redacted<string>,
  ) => Effect.Effect<AuthorizationResult, AuthError>
}
export class Host extends Context.Service<Host, HostInterface>()("@rika/app/openai-auth/Host") {}

export interface DevicePrompt {
  readonly verificationUrl: string
  readonly userCode: string
  readonly warning: string
}
export interface PresenterInterface {
  readonly device: (prompt: DevicePrompt) => Effect.Effect<void, AuthError>
}
export class Presenter extends Context.Service<Presenter, PresenterInterface>()("@rika/app/openai-auth/Presenter") {}

export const TokenResponse = Schema.Struct({
  access_token: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Int),
})
export type TokenResponse = typeof TokenResponse.Type
export const DeviceStartResponse = Schema.Struct({
  device_auth_id: Schema.String,
  user_code: Schema.String,
  interval: Schema.String,
})
export const DevicePollResponse = Schema.Struct({
  authorization_code: Schema.String,
  code_challenge: Schema.String,
  code_verifier: Schema.String,
})

export interface HttpInterface {
  readonly exchange: (input: {
    readonly code: Redacted.Redacted<string>
    readonly verifier: Redacted.Redacted<string>
    readonly redirectUri: string
  }) => Effect.Effect<TokenResponse, AuthError>
  readonly refresh: (refreshToken: Redacted.Redacted<string>) => Effect.Effect<TokenResponse, AuthError>
  readonly deviceStart: Effect.Effect<typeof DeviceStartResponse.Type, AuthError>
  readonly devicePoll: (
    deviceAuthId: Redacted.Redacted<string>,
    userCode: string,
  ) => Effect.Effect<Option.Option<typeof DevicePollResponse.Type>, AuthError>
}
export class Http extends Context.Service<Http, HttpInterface>()("@rika/app/openai-auth/Http") {}

export const CredentialDisk = Schema.Struct({
  formatVersion: Schema.Literal(credentialFormatVersion),
  accessToken: Schema.String,
  idToken: Schema.String,
  refreshToken: Schema.String,
  accountId: Schema.String,
  fingerprint: Schema.String,
  generation: Schema.String,
  expiresAt: Schema.Finite,
  refreshedAt: Schema.Finite,
})
type CredentialDisk = typeof CredentialDisk.Type
export interface Credential {
  readonly accessToken: Redacted.Redacted<string>
  readonly idToken: Redacted.Redacted<string>
  readonly refreshToken: Redacted.Redacted<string>
  readonly accountId: Redacted.Redacted<string>
  readonly fingerprint: string
  readonly generation: string
  readonly expiresAt: number
  readonly refreshedAt: number
}
const publicCredential = (value: CredentialDisk): Credential => ({
  accessToken: Redacted.make(value.accessToken),
  idToken: Redacted.make(value.idToken),
  refreshToken: Redacted.make(value.refreshToken),
  accountId: Redacted.make(value.accountId),
  fingerprint: value.fingerprint,
  generation: value.generation,
  expiresAt: value.expiresAt,
  refreshedAt: value.refreshedAt,
})

export interface StoreInterface {
  readonly load: Effect.Effect<Option.Option<CredentialDisk>, StoreError>
  readonly save: (credential: CredentialDisk) => Effect.Effect<void, StoreError>
  readonly remove: Effect.Effect<boolean, StoreError>
  readonly serialized: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | StoreError, R>
}
export class Store extends Context.Service<Store, StoreInterface>()("@rika/app/openai-auth/Store") {}

const utf8 = (value: string) =>
  Result.match(Encoding.decodeBase64(Encoding.encodeBase64(value)), {
    onFailure: () => Effect.fail(authError("protocol", "Text encoding failed")),
    onSuccess: Effect.succeed,
  })

export const makePkce = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const verifier = Redacted.make(Encoding.encodeBase64Url(yield* crypto.randomBytes(64)))
  const verifierBytes = yield* utf8(Redacted.value(verifier))
  const challenge = Encoding.encodeBase64Url(yield* crypto.digest("SHA-256", verifierBytes))
  const state = Redacted.make(Encoding.encodeBase64Url(yield* crypto.randomBytes(32)))
  return { verifier, challenge, state }
}).pipe(Effect.mapError(() => authError("protocol", "Cryptographic operation failed")))

const authorizationUrlImpl = (challenge: string, state: Redacted.Redacted<string>, redirect = redirectUri) => {
  const url = new URL(`${issuer}/oauth/authorize`)
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    scope: scopes,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: Redacted.value(state),
    originator,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  }).toString()
  return url
}

export const authorizationUrl: {
  (challenge: string, state: Redacted.Redacted<string>, redirect?: string): URL
  (state: Redacted.Redacted<string>, redirect?: string): (challenge: string) => URL
} = Function.dual((args) => typeof args[0] === "string", authorizationUrlImpl)

const IdentityClaims = Schema.Struct({
  exp: Schema.optionalKey(Schema.Int),
  "https://api.openai.com/auth": Schema.Struct({
    chatgpt_account_id: Schema.optionalKey(Schema.String),
    chatgpt_user_id: Schema.optionalKey(Schema.String),
    user_id: Schema.optionalKey(Schema.String),
  }),
})

const ExpiryClaims = Schema.Struct({ exp: Schema.optionalKey(Schema.Int) })

const decodeJwt = <S extends Schema.Constraint>(token: string, schema: S) =>
  Effect.gen(function* () {
    const part = token.split(".")[1]
    if (part === undefined) return yield* authError("protocol", "Token payload is malformed")
    const decoded = Encoding.decodeBase64UrlString(part)
    if (Result.isFailure(decoded)) return yield* authError("protocol", "Token payload is malformed")
    return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(decoded.success).pipe(
      Effect.mapError(() => authError("protocol", "Token claims are incomplete")),
    )
  })

const credentialFrom = (crypto: Crypto.Crypto, response: TokenResponse, previous?: CredentialDisk) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const accessToken = response.access_token ?? previous?.accessToken
    const idToken = response.id_token ?? previous?.idToken
    const refreshToken = response.refresh_token ?? previous?.refreshToken
    if (accessToken === undefined || idToken === undefined || refreshToken === undefined) {
      return yield* authError("protocol", "Token exchange was incomplete")
    }
    const claims = yield* decodeJwt(idToken, IdentityClaims)
    const identity = claims["https://api.openai.com/auth"]
    const accountId = identity.chatgpt_account_id
    const userId = identity.chatgpt_user_id ?? identity.user_id
    if (accountId === undefined || userId === undefined) {
      return yield* authError("protocol", "Required identity claims are missing")
    }
    const identityBytes = yield* utf8(`${accountId}\u0000${userId}`)
    const fingerprint = Encoding.encodeBase64Url(yield* crypto.digest("SHA-256", identityBytes))
    if (previous !== undefined && fingerprint !== previous.fingerprint) {
      return yield* authError(
        "account-mismatch",
        "Refreshed credentials belong to a different account; login is required",
      )
    }
    const accessClaims = yield* decodeJwt(accessToken, ExpiryClaims).pipe(Effect.option)
    const tokenExpiry = Option.isSome(accessClaims) ? accessClaims.value.exp : undefined
    if (response.expires_in !== undefined && (response.expires_in < 0 || !Number.isSafeInteger(response.expires_in))) {
      return yield* authError("protocol", "Token expiry is invalid")
    }
    if (tokenExpiry !== undefined && (tokenExpiry < 0 || !Number.isSafeInteger(tokenExpiry))) {
      return yield* authError("protocol", "Token expiry is invalid")
    }
    return {
      formatVersion: credentialFormatVersion,
      accessToken,
      idToken,
      refreshToken,
      accountId,
      fingerprint,
      generation: `${fingerprint}.${Encoding.encodeBase64Url(yield* crypto.randomBytes(16))}`,
      expiresAt:
        response.access_token !== undefined && response.expires_in !== undefined
          ? now + response.expires_in * 1000
          : tokenExpiry !== undefined
            ? tokenExpiry * 1000
            : (previous?.expiresAt ?? now + 8 * 86_400_000),
      refreshedAt: now,
    } satisfies CredentialDisk
  }).pipe(
    Effect.mapError((error) =>
      Schema.is(AuthError)(error) ? error : authError("protocol", "Cryptographic operation failed"),
    ),
  )

export type Status =
  | { readonly _tag: "Unauthenticated" }
  | { readonly _tag: "Present"; readonly fingerprint: string }
  | { readonly _tag: "RefreshRequired"; readonly fingerprint: string }
  | { readonly _tag: "Corrupt" }
export interface ServiceInterface {
  readonly loginBrowser: (redirect?: string) => Effect.Effect<Credential, Error>
  readonly loginDevice: Effect.Effect<Credential, Error>
  readonly status: Effect.Effect<Status, StoreError>
  readonly logout: Effect.Effect<{ readonly removed: boolean; readonly revocationSupported: false }, StoreError>
  readonly acquire: Effect.Effect<Credential, Error>
  readonly refreshRejected: (generation: string) => Effect.Effect<Credential, Error>
}
export class Service extends Context.Service<Service, ServiceInterface>()("@rika/app/openai-auth/Service") {}

export interface TimingOptions {
  readonly deviceTimeout?: number
}

export const layer = (options: TimingOptions = {}) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const host = yield* Host
      const presenter = yield* Presenter
      const http = yield* Http
      const store = yield* Store
      const crypto = yield* Crypto.Crypto
      const persist = (response: TokenResponse, previous?: CredentialDisk) =>
        Effect.gen(function* () {
          const value = yield* credentialFrom(crypto, response, previous)
          yield* store.save(value)
          return publicCredential(value)
        })
      const refreshGeneration = (generation: string) =>
        store.serialized(
          Effect.gen(function* () {
            const current = yield* store.load
            if (Option.isNone(current)) return yield* authError("login-required", "Login is required")
            if (current.value.generation !== generation) {
              const separator = generation.lastIndexOf(".")
              const expectedFingerprint = separator < 0 ? undefined : generation.slice(0, separator)
              if (expectedFingerprint !== undefined && expectedFingerprint !== current.value.fingerprint) {
                return yield* authError(
                  "account-mismatch",
                  "OpenAI account changed while the request was active; start the turn again",
                )
              }
              return publicCredential(current.value)
            }
            const response = yield* http.refresh(Redacted.make(current.value.refreshToken))
            return yield* persist(response, current.value)
          }),
        )
      const service: ServiceInterface = {
        loginBrowser: (redirect = redirectUri) =>
          Effect.gen(function* () {
            const pkce = yield* makePkce.pipe(Effect.provideService(Crypto.Crypto, crypto))
            const result = yield* host.authorize(authorizationUrl(pkce.challenge, pkce.state, redirect), pkce.state)
            if (Redacted.value(result.state) !== Redacted.value(pkce.state)) {
              return yield* authError("protocol", "Authorization state did not match")
            }
            const response = yield* http.exchange({ code: result.code, verifier: pkce.verifier, redirectUri: redirect })
            return yield* store.serialized(persist(response))
          }),
        loginDevice: Effect.gen(function* () {
          const start = yield* http.deviceStart
          yield* presenter.device({
            verificationUrl: deviceVerificationUrl,
            userCode: start.user_code,
            warning:
              "Continue only if you started this login in Rika. If a website or another person gave you this code, cancel.",
          })
          const normalizedInterval = start.interval.trim()
          const interval = /^\d+$/.test(normalizedInterval) ? Number(normalizedInterval) : Number.NaN
          if (!Number.isSafeInteger(interval) || interval < 1) {
            return yield* authError("protocol", "Device authorization interval is invalid")
          }
          const deadline = (yield* Clock.currentTimeMillis) + (options.deviceTimeout ?? 900_000)
          let result: typeof DevicePollResponse.Type
          while (true) {
            yield* Effect.sleep(`${interval} seconds`)
            const remaining = deadline - (yield* Clock.currentTimeMillis)
            if (remaining <= 0) {
              return yield* authError("timeout", "Device authorization expired")
            }
            const polled = yield* http
              .devicePoll(Redacted.make(start.device_auth_id), start.user_code)
              .pipe(Effect.timeoutOption(remaining))
            if (Option.isNone(polled) || (yield* Clock.currentTimeMillis) >= deadline) {
              return yield* authError("timeout", "Device authorization expired")
            }
            if (Option.isSome(polled.value)) {
              result = polled.value.value
              break
            }
          }
          const response = yield* http.exchange({
            code: Redacted.make(result.authorization_code),
            verifier: Redacted.make(result.code_verifier),
            redirectUri: deviceExchangeRedirect,
          })
          return yield* store.serialized(persist(response))
        }),
        status: Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          return yield* store.load.pipe(
            Effect.matchEffect({
              onFailure: (error) =>
                error.kind === "corrupt" ? Effect.succeed<Status>({ _tag: "Corrupt" }) : Effect.fail(error),
              onSuccess: (entry) =>
                Effect.succeed<Status>(
                  Option.isNone(entry)
                    ? { _tag: "Unauthenticated" }
                    : entry.value.expiresAt <= now + 300_000
                      ? { _tag: "RefreshRequired", fingerprint: entry.value.fingerprint }
                      : { _tag: "Present", fingerprint: entry.value.fingerprint },
                ),
            }),
          )
        }),
        logout: store
          .serialized(store.remove)
          .pipe(Effect.map((removed) => ({ removed, revocationSupported: false as const }))),
        acquire: Effect.gen(function* () {
          const entry = yield* store.load
          if (Option.isNone(entry)) return yield* authError("login-required", "Login is required")
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
