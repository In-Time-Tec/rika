import { Redacted, Schema } from "effect"

export const TokenResponse = Schema.Struct({
  access_token: Schema.optionalKey(Schema.String),
  id_token: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Int),
})
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
export const CredentialDisk = Schema.Struct({
  formatVersion: Schema.Literal(1),
  accessToken: Schema.String,
  idToken: Schema.String,
  refreshToken: Schema.String,
  accountId: Schema.String,
  fingerprint: Schema.String,
  generation: Schema.String,
  expiresAt: Schema.Finite,
  refreshedAt: Schema.Finite,
})

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("OpenAiAuthError", {
  kind: Schema.Literals(["cancelled", "timeout", "host", "network", "protocol", "account-mismatch", "login-required"]),
  message: Schema.String,
}) {}

export class StoreError extends Schema.TaggedErrorClass<StoreError>()("OpenAiCredentialStoreError", {
  kind: Schema.Literals(["missing", "corrupt", "unsafe", "busy", "io"]),
  message: Schema.String,
}) {}

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

export type Status =
  | { readonly _tag: "Unauthenticated" }
  | { readonly _tag: "Present"; readonly fingerprint: string }
  | { readonly _tag: "RefreshRequired"; readonly fingerprint: string }
  | { readonly _tag: "Corrupt" }
