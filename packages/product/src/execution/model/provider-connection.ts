import { Schema } from "effect"

export const ProviderAuthentication = Schema.Literals(["api-key", "account", "none"])
export type ProviderAuthentication = typeof ProviderAuthentication.Type
export const ProviderConnectionSnapshot = Schema.Struct({
  provider: Schema.String,
  protocol: Schema.String,
  baseUrl: Schema.String,
  authentication: ProviderAuthentication,
  apiKeyEnvironment: Schema.optionalKey(Schema.String),
  credentialIdentity: Schema.optionalKey(Schema.String),
  accountFingerprint: Schema.optionalKey(Schema.String),
})
export type ProviderConnectionSnapshot = typeof ProviderConnectionSnapshot.Type
