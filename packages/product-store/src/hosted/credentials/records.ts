import { Effect, Schema } from "effect"
import { rikaHostedOpenaiAccountCredentials, rikaHostedProviderCredentials } from "../../database/schema/product"

export const Provider = Schema.Literals(["openai", "anthropic", "openrouter"])
export type Provider = typeof Provider.Type
export const CredentialState = Schema.Literals(["active", "revoked"])
export type CredentialState = typeof CredentialState.Type

export class ProviderCredentialsError extends Schema.TaggedError<ProviderCredentialsError>()(
  "ProviderCredentialsError",
  { kind: Schema.Literals(["database", "forbidden", "missing"]), message: Schema.String },
) {}

export interface CredentialRecord {
  readonly credentialIdentity: string
  readonly ownerId: string
  readonly provider: Provider
  readonly status: CredentialState
  readonly revision: string
  readonly keyVersion: number | null
  readonly nonce: Uint8Array | null
  readonly ciphertext: Uint8Array | null
  readonly authenticationTag: Uint8Array | null
}

export interface OpenAiAccountRecord {
  readonly credentialIdentity: string
  readonly ownerId: string
  readonly status: CredentialState
  readonly revision: string
  readonly fingerprint: string
  readonly keyVersion: number | null
  readonly nonce: Uint8Array | null
  readonly ciphertext: Uint8Array | null
  readonly authenticationTag: Uint8Array | null
}

const ProviderMetadata = Schema.Struct({ encryption: Schema.String, keyVersion: Schema.Finite })
const AccountMetadata = Schema.Struct({
  authentication: Schema.String,
  encryption: Schema.String,
  keyVersion: Schema.Finite,
})

export const providerMetadata = Schema.decodeSync(ProviderMetadata)({ encryption: "aes-256-gcm", keyVersion: 1 })
export const accountMetadata = Schema.decodeSync(AccountMetadata)({
  authentication: "account",
  encryption: "aes-256-gcm",
  keyVersion: 1,
})

const failure = (kind: ProviderCredentialsError["kind"], message: string) =>
  ProviderCredentialsError.make({ kind, message })
const database = () => failure("database", "Provider credential database operation failed")

export const credentialRecord = Effect.fn("ProviderCredentials.credentialRecord")(function* (
  row: typeof rikaHostedProviderCredentials.$inferSelect,
) {
  return {
    credentialIdentity: row.credentialReferenceId,
    ownerId: row.ownerId,
    provider: yield* Schema.decodeUnknownEffect(Provider)(row.provider),
    status: yield* Schema.decodeUnknownEffect(CredentialState)(row.status),
    revision: String(row.revision),
    keyVersion: row.keyVersion,
    nonce: row.nonce instanceof Uint8Array ? row.nonce : null,
    ciphertext: row.ciphertext instanceof Uint8Array ? row.ciphertext : null,
    authenticationTag: row.authenticationTag instanceof Uint8Array ? row.authenticationTag : null,
  }
}, Effect.mapError(database))

export const accountRecord = Effect.fn("ProviderCredentials.accountRecord")(function* (
  row: typeof rikaHostedOpenaiAccountCredentials.$inferSelect,
) {
  return {
    credentialIdentity: row.credentialReferenceId,
    ownerId: row.ownerId,
    status: yield* Schema.decodeUnknownEffect(CredentialState)(row.status),
    revision: String(row.revision),
    fingerprint: row.fingerprint,
    keyVersion: row.keyVersion,
    nonce: row.nonce instanceof Uint8Array ? row.nonce : null,
    ciphertext: row.ciphertext instanceof Uint8Array ? row.ciphertext : null,
    authenticationTag: row.authenticationTag instanceof Uint8Array ? row.authenticationTag : null,
  }
}, Effect.mapError(database))

export const credentialRecords = Effect.forEach(credentialRecord)
export const accountRecords = Effect.forEach(accountRecord)
