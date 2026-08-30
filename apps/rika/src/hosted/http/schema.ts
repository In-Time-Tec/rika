import { Effect, Schema } from "effect"
import { CliDevice, HostedError, ProviderCredentialStatus, RecoveryOperation, type TokenSet } from "../contract"

export const RegistrationWire = Schema.Struct({ client_id: Schema.String })
export const DeviceAuthorizationWire = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optionalKey(Schema.String),
  expires_in: Schema.Int,
  interval: Schema.optionalKey(Schema.Int),
})
export const TokenWire = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.Int,
  token_type: Schema.optionalKey(Schema.String),
})
export const OAuthErrorWire = Schema.Struct({
  error: Schema.String,
  error_description: Schema.optionalKey(Schema.String),
})
export const DevicesWire = Schema.Union([Schema.Array(CliDevice), Schema.Struct({ devices: Schema.Array(CliDevice) })])
export const ProviderCredentialsWire = Schema.Struct({ credentials: Schema.Array(ProviderCredentialStatus) })
export const RecoveryOperationsWire = Schema.Struct({ operations: Schema.Array(RecoveryOperation) })

export const tokensFrom =
  (previousRefreshToken?: string) =>
  (wire: typeof TokenWire.Type): Effect.Effect<TokenSet, HostedError> => {
    const refreshToken = wire.refresh_token ?? previousRefreshToken
    if (
      refreshToken === undefined ||
      wire.expires_in <= 0 ||
      (wire.token_type !== undefined && wire.token_type.toLowerCase() !== "dpop")
    )
      return Effect.fail(
        HostedError.make({ kind: "protocol", message: "Token response was not a valid DPoP token response" }),
      )
    return Effect.succeed({ accessToken: wire.access_token, refreshToken, expiresIn: wire.expires_in })
  }
