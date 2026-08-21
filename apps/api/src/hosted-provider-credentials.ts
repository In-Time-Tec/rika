import * as PgClient from "@effect/sql-pg/PgClient"
import { Clock, Context, Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect"
import { ProviderCredentialStore, ProviderCredentialStoreError } from "@rika/product/provider-credential-store"
import type { HostedOwner } from "@rika/product/hosted-model"
import type { AuthenticatedPrincipal } from "./hosted-product"
import { makeProviderCredentialCipher } from "./provider-credential-cipher"

export const HostedModelProvider = Schema.Literals(["openai", "anthropic", "openrouter"])
export type HostedModelProvider = typeof HostedModelProvider.Type

export class HostedProviderCredentialError extends Schema.TaggedError<HostedProviderCredentialError>()(
  "HostedProviderCredentialError",
  {
    kind: Schema.Literals(["corrupt", "forbidden", "invalid", "missing", "revoked", "unavailable"]),
    message: Schema.String,
  },
) {}

export interface HostedProviderCredentialStatus {
  readonly provider: HostedModelProvider
  readonly state: "active" | "revoked"
  readonly revision: string
  readonly credentialIdentity: string
}

export interface HostedProviderCredentialsService {
  readonly put: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: HostedOwner
    readonly provider: HostedModelProvider
    readonly apiKey: Redacted.Redacted<string>
  }) => Effect.Effect<HostedProviderCredentialStatus, HostedProviderCredentialError>
  readonly revoke: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: HostedOwner
    readonly provider: HostedModelProvider
  }) => Effect.Effect<HostedProviderCredentialStatus, HostedProviderCredentialError>
  readonly list: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: HostedOwner
  }) => Effect.Effect<ReadonlyArray<HostedProviderCredentialStatus>, HostedProviderCredentialError>
  readonly require: (
    ownerId: string,
    provider: HostedModelProvider,
  ) => Effect.Effect<HostedProviderCredentialStatus, HostedProviderCredentialError>
}

export class HostedProviderCredentials extends Context.Service<
  HostedProviderCredentials,
  HostedProviderCredentialsService
>()("@rika/api/hosted-provider-credentials/HostedProviderCredentials") {}

interface CredentialRow {
  readonly credential_identity: string
  readonly owner_id: string
  readonly provider: HostedModelProvider
  readonly status: "active" | "revoked"
  readonly revision: string
  readonly key_version: number | null
  readonly nonce: Uint8Array | null
  readonly ciphertext: Uint8Array | null
  readonly authentication_tag: Uint8Array | null
}

const rejected = (kind: HostedProviderCredentialError["kind"], message: string) =>
  HostedProviderCredentialError.make({ kind, message })
const unavailable = () => rejected("unavailable", "Provider credential service is unavailable")
const storeError = (kind: ProviderCredentialStoreError["kind"], message: string) =>
  ProviderCredentialStoreError.make({ kind, message })
const identity = (row: CredentialRow): HostedProviderCredentialStatus => ({
  provider: row.provider,
  state: row.status,
  revision: row.revision,
  credentialIdentity: row.credential_identity,
})

export const layer = (options: { readonly encryptionKey: Redacted.Redacted<string> }) =>
  Layer.effect(
    HostedProviderCredentials,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const crypto = yield* Crypto.Crypto
      const cipher = makeProviderCredentialCipher(options.encryptionKey)
      const authorizedOwnerId = Effect.fn("HostedProviderCredentials.authorizedOwnerId")(function* (
        principal: AuthenticatedPrincipal,
        owner: HostedOwner,
      ) {
        if (owner._tag === "PersonalOwner" && owner.userId !== principal.userId) {
          return yield* rejected("forbidden", "Owner is unavailable")
        }
        const rows = yield* sql<{ readonly id: string }>`SELECT owner_record.id
          FROM rika_hosted_owners owner_record
          WHERE (
            ${owner._tag === "PersonalOwner"}
            AND owner_record.user_id = ${owner._tag === "PersonalOwner" ? owner.userId : ""}
          ) OR (
            ${owner._tag === "OrganizationOwner"}
            AND owner_record.organization_id = ${owner._tag === "OrganizationOwner" ? owner.organizationId : ""}
            AND EXISTS (
              SELECT 1 FROM "member"
              WHERE organization_id = owner_record.organization_id
                AND user_id = ${principal.userId}
                AND role IN ('owner', 'admin')
            )
          )`.pipe(Effect.catchTag("SqlError", unavailable))
        if (rows[0] === undefined) return yield* rejected("forbidden", "Owner is unavailable")
        return rows[0].id
      })
      const credential = Effect.fn("HostedProviderCredentials.credential")(function* (
        ownerId: string,
        provider: HostedModelProvider,
      ) {
        const rows = yield* sql<CredentialRow>`SELECT
            credential_reference_id AS credential_identity,
            owner_id,
            provider,
            status,
            revision::text AS revision,
            key_version,
            nonce,
            ciphertext,
            authentication_tag
          FROM rika_hosted_provider_credentials
          WHERE owner_id = ${ownerId} AND provider = ${provider}`.pipe(Effect.catchTag("SqlError", unavailable))
        return rows[0]
      })
      const put: HostedProviderCredentialsService["put"] = Effect.fn("HostedProviderCredentials.put")(
        function* (input) {
          if (Redacted.value(input.apiKey).trim().length === 0) {
            return yield* rejected("invalid", "Provider credential must not be empty")
          }
          const ownerId = yield* authorizedOwnerId(input.principal, input.owner)
          const credentialReferenceId = `provider-credential-${yield* crypto.randomUUIDv4.pipe(
            Effect.mapError(unavailable),
          )}`
          const encrypted = cipher.encrypt(`${ownerId}/${input.provider}`, input.apiKey)
          const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
          const rows = yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const references = yield* sql<{ readonly id: string }>`INSERT INTO rika_hosted_credential_references
                  (id, owner_id, provider, purpose, external_reference, metadata, created_by_user_id, created_at, updated_at)
                VALUES (
                  ${credentialReferenceId}, ${ownerId}, ${input.provider}, 'model-provider',
                  ${`postgresql://${credentialReferenceId}`}, ${'{"encryption":"aes-256-gcm","keyVersion":1}'}::jsonb,
                  ${input.principal.userId}, ${now}, ${now}
                )
                ON CONFLICT (owner_id, provider) WHERE purpose = 'model-provider'
                DO UPDATE SET metadata = EXCLUDED.metadata, updated_at = EXCLUDED.updated_at
                RETURNING id`
                const reference = references[0]
                if (reference === undefined) return yield* unavailable()
                return yield* sql<CredentialRow>`INSERT INTO rika_hosted_provider_credentials
                  (credential_reference_id, owner_id, provider, status, revision, key_version, nonce,
                    ciphertext, authentication_tag, created_at, updated_at, rotated_at, revoked_at)
                VALUES (
                  ${reference.id}, ${ownerId}, ${input.provider}, 'active', 1, ${encrypted.keyVersion},
                  ${encrypted.nonce}, ${encrypted.ciphertext}, ${encrypted.authenticationTag},
                  ${now}, ${now}, NULL, NULL
                )
                ON CONFLICT (owner_id, provider) DO UPDATE SET
                  status = 'active',
                  revision = rika_hosted_provider_credentials.revision + 1,
                  key_version = EXCLUDED.key_version,
                  nonce = EXCLUDED.nonce,
                  ciphertext = EXCLUDED.ciphertext,
                  authentication_tag = EXCLUDED.authentication_tag,
                  updated_at = EXCLUDED.updated_at,
                  rotated_at = EXCLUDED.updated_at,
                  revoked_at = NULL
                RETURNING credential_reference_id AS credential_identity, owner_id, provider, status,
                  revision::text AS revision, key_version, nonce, ciphertext, authentication_tag`
              }),
            )
            .pipe(Effect.catchTag("SqlError", unavailable))
          const row = rows[0]
          if (row === undefined) return yield* unavailable()
          return identity(row)
        },
      )
      const revoke: HostedProviderCredentialsService["revoke"] = Effect.fn("HostedProviderCredentials.revoke")(
        function* (input) {
          const ownerId = yield* authorizedOwnerId(input.principal, input.owner)
          const now = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
          const rows = yield* sql<CredentialRow>`UPDATE rika_hosted_provider_credentials
          SET status = 'revoked', revision = revision + 1, key_version = NULL, nonce = NULL,
            ciphertext = NULL, authentication_tag = NULL, updated_at = ${now}, revoked_at = ${now}
          WHERE owner_id = ${ownerId} AND provider = ${input.provider}
          RETURNING credential_reference_id AS credential_identity, owner_id, provider, status,
            revision::text AS revision, key_version, nonce, ciphertext, authentication_tag`.pipe(
            Effect.catchTag("SqlError", unavailable),
          )
          const row = rows[0]
          if (row === undefined) return yield* rejected("missing", "Provider credential is not configured")
          return identity(row)
        },
      )
      const list: HostedProviderCredentialsService["list"] = Effect.fn("HostedProviderCredentials.list")(
        function* (input) {
          const ownerId = yield* authorizedOwnerId(input.principal, input.owner)
          const rows = yield* sql<CredentialRow>`SELECT
              credential_reference_id AS credential_identity, owner_id, provider, status,
              revision::text AS revision, key_version, nonce, ciphertext, authentication_tag
            FROM rika_hosted_provider_credentials
            WHERE owner_id = ${ownerId}
            ORDER BY provider`.pipe(Effect.catchTag("SqlError", unavailable))
          return rows.map(identity)
        },
      )
      const requireCredential: HostedProviderCredentialsService["require"] = Effect.fn(
        "HostedProviderCredentials.require",
      )(function* (ownerId, provider) {
        const row = yield* credential(ownerId, provider)
        if (row === undefined) return yield* rejected("missing", "Provider credential is not configured")
        if (row.status === "revoked") return yield* rejected("revoked", "Provider credential is revoked")
        return identity(row)
      })
      return HostedProviderCredentials.of({ put, revoke, list, require: requireCredential })
    }),
  )

export const storeLayer = (options: { readonly encryptionKey: Redacted.Redacted<string> }) =>
  Layer.effect(
    ProviderCredentialStore,
    Effect.gen(function* () {
      const sql = yield* PgClient.PgClient
      const cipher = makeProviderCredentialCipher(options.encryptionKey)
      return ProviderCredentialStore.of({
        load: (credentialIdentity) =>
          sql<CredentialRow>`SELECT
              credential_reference_id AS credential_identity, owner_id, provider, status, revision::text AS revision,
              key_version, nonce, ciphertext, authentication_tag
            FROM rika_hosted_provider_credentials
            WHERE credential_reference_id = ${credentialIdentity}`.pipe(
            Effect.mapError(() => storeError("io", "Provider credential load failed")),
            Effect.flatMap((rows) => {
              const row = rows[0]
              if (row === undefined || row.status === "revoked") return Effect.succeed(Option.none())
              if (
                row.key_version !== 1 ||
                row.nonce === null ||
                row.ciphertext === null ||
                row.authentication_tag === null
              ) {
                return Effect.fail(storeError("corrupt", "Provider credential record is corrupt"))
              }
              return Effect.try({
                try: () =>
                  Option.some(
                    cipher.decrypt(`${row.owner_id}/${row.provider}`, {
                      keyVersion: 1,
                      nonce: row.nonce!,
                      ciphertext: row.ciphertext!,
                      authenticationTag: row.authentication_tag!,
                    }),
                  ),
                catch: () => storeError("corrupt", "Provider credential cannot be decrypted"),
              })
            }),
          ),
        save: () => Effect.fail(storeError("unsafe", "Hosted credentials require an authenticated write")),
        remove: () => Effect.fail(storeError("unsafe", "Hosted credentials require an authenticated revoke")),
      })
    }),
  )
