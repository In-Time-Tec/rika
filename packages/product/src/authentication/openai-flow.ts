import { Clock, Crypto, Effect, Encoding, Function, Option, Redacted, Result, Schema } from "effect"
import * as Contract from "./openai-contract"

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

const requiredTokens = (
  response: typeof Contract.TokenResponse.Type,
  previous?: typeof Contract.CredentialDisk.Type,
) => {
  const tokens = {
    accessToken: response.access_token ?? previous?.accessToken,
    idToken: response.id_token ?? previous?.idToken,
    refreshToken: response.refresh_token ?? previous?.refreshToken,
  }
  return tokens.accessToken === undefined || tokens.idToken === undefined || tokens.refreshToken === undefined
    ? undefined
    : { accessToken: tokens.accessToken, idToken: tokens.idToken, refreshToken: tokens.refreshToken }
}

const validExpiry = (value: number | undefined) => value === undefined || (value >= 0 && Number.isSafeInteger(value))

const expiryAt = (
  now: number,
  response: typeof Contract.TokenResponse.Type,
  tokenExpiry: number | undefined,
  previous?: typeof Contract.CredentialDisk.Type,
) => {
  if (response.access_token !== undefined && response.expires_in !== undefined) return now + response.expires_in * 1000
  if (tokenExpiry !== undefined) return tokenExpiry * 1000
  return previous?.expiresAt ?? now + 8 * 86_400_000
}

const decodeJwt = <S extends Schema.Constraint>(token: string, schema: S) =>
  Effect.gen(function* () {
    const part = token.split(".")[1]
    if (part === undefined) return yield* authError("protocol", "Token payload is malformed")
    const decoded = Encoding.decodeBase64UrlString(part)
    if (Result.isFailure(decoded)) return yield* authError("protocol", "Token payload is malformed")
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(decoded.success).pipe(
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
  } = Function.dual((args) => Schema.is(Schema.String)(args[0]), authorizationUrlImpl)

  export const credentialFrom = (
    crypto: Crypto.Crypto,
    response: typeof Contract.TokenResponse.Type,
    previous?: typeof Contract.CredentialDisk.Type,
  ) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const tokens = requiredTokens(response, previous)
      if (tokens === undefined) return yield* authError("protocol", "Token exchange was incomplete")
      const { accessToken, idToken, refreshToken } = tokens
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
      if (!validExpiry(response.expires_in) || !validExpiry(tokenExpiry)) {
        return yield* authError("protocol", "Token expiry is invalid")
      }
      const expiresAt = expiryAt(now, response, tokenExpiry, previous)
      return Contract.CredentialDisk.make({
        formatVersion: configuration.credentialFormatVersion,
        accessToken,
        idToken,
        refreshToken,
        accountId,
        fingerprint,
        generation: `${fingerprint}.${Encoding.encodeBase64Url(yield* crypto.randomBytes(16))}`,
        expiresAt,
        refreshedAt: now,
      })
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(Contract.AuthError)(error) ? error : authError("protocol", "Cryptographic operation failed"),
      ),
    )
}
