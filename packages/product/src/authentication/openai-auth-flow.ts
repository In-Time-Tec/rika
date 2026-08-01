import { Clock, Crypto, Effect, Encoding, Function, Option, Redacted, Result, Schema } from "effect"
import * as Contract from "./openai-auth-contract"

export const configuration = {
  issuer: "https://auth.openai.com",
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  redirectUri: "http://localhost:1455/auth/callback",
  scopes: "openid profile email offline_access api.connectors.read api.connectors.invoke",
  originator: "codex_cli_rs",
  deviceVerificationUrl: "https://auth.openai.com/codex/device",
  deviceExchangeRedirect: "https://auth.openai.com/deviceauth/callback",
  credentialFormatVersion: 1,
  maxCredentialFileSize: 256 * 1024,
} as const

type AuthorizationResult = {
  readonly code: Redacted.Redacted<string>
  readonly state: Redacted.Redacted<string>
}

type DevicePrompt = {
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

interface PresenterInterface {
  readonly device: (prompt: DevicePrompt) => Effect.Effect<void, Contract.AuthError>
}

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

interface StoreInterface {
  readonly load: Effect.Effect<Option.Option<typeof Contract.CredentialDisk.Type>, Contract.StoreError>
  readonly save: (credential: typeof Contract.CredentialDisk.Type) => Effect.Effect<void, Contract.StoreError>
  readonly remove: Effect.Effect<boolean, Contract.StoreError>
  readonly serialized: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | Contract.StoreError, R>
}

const authError = (kind: Contract.AuthError["kind"], message: string) => Contract.AuthError.make({ kind, message })

const utf8 = (value: string) =>
  Result.match(Encoding.decodeBase64(Encoding.encodeBase64(value)), {
    onFailure: () => Effect.fail(authError("protocol", "Text encoding failed")),
    onSuccess: Effect.succeed,
  })

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

export namespace Flow {
  export const makePkce = Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    const verifier = Redacted.make(Encoding.encodeBase64Url(yield* crypto.randomBytes(64)))
    const verifierBytes = yield* utf8(Redacted.value(verifier))
    const challenge = Encoding.encodeBase64Url(yield* crypto.digest("SHA-256", verifierBytes))
    const state = Redacted.make(Encoding.encodeBase64Url(yield* crypto.randomBytes(32)))
    return { verifier, challenge, state }
  }).pipe(Effect.mapError(() => authError("protocol", "Cryptographic operation failed")))

  const authorizationUrlImpl = (
    challenge: string,
    state: Redacted.Redacted<string>,
    redirect = configuration.redirectUri,
  ) => {
    const url = new URL(`${configuration.issuer}/oauth/authorize`)
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: configuration.clientId,
      redirect_uri: redirect,
      scope: configuration.scopes,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: Redacted.value(state),
      originator: configuration.originator,
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
    }).toString()
    return url
  }

  export const authorizationUrl: {
    (challenge: string, state: Redacted.Redacted<string>, redirect?: string): URL
    (state: Redacted.Redacted<string>, redirect?: string): (challenge: string) => URL
  } = Function.dual((args) => typeof args[0] === "string", authorizationUrlImpl)

  export const credentialFrom = (
    crypto: Crypto.Crypto,
    response: typeof Contract.TokenResponse.Type,
    previous?: typeof Contract.CredentialDisk.Type,
  ) =>
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
      if (
        response.expires_in !== undefined &&
        (response.expires_in < 0 || !Number.isSafeInteger(response.expires_in))
      ) {
        return yield* authError("protocol", "Token expiry is invalid")
      }
      if (tokenExpiry !== undefined && (tokenExpiry < 0 || !Number.isSafeInteger(tokenExpiry))) {
        return yield* authError("protocol", "Token expiry is invalid")
      }
      let expiresAt: number
      if (response.access_token !== undefined && response.expires_in !== undefined) {
        expiresAt = now + response.expires_in * 1000
      } else if (tokenExpiry !== undefined) {
        expiresAt = tokenExpiry * 1000
      } else {
        expiresAt = previous?.expiresAt ?? now + 8 * 86_400_000
      }
      return {
        formatVersion: configuration.credentialFormatVersion,
        accessToken,
        idToken,
        refreshToken,
        accountId,
        fingerprint,
        generation: `${fingerprint}.${Encoding.encodeBase64Url(yield* crypto.randomBytes(16))}`,
        expiresAt,
        refreshedAt: now,
      } satisfies typeof Contract.CredentialDisk.Type
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(Contract.AuthError)(error) ? error : authError("protocol", "Cryptographic operation failed"),
      ),
    )
}
