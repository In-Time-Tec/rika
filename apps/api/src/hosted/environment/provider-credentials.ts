import * as OpenAiAuthContract from "@rika/product/openai-auth-contract"
import * as OpenAiAuth from "@rika/product/openai-auth-service"
import { ProviderCredentialStore, ProviderCredentialStoreError } from "@rika/product/provider-credential-store"
import {
  make as makeProviderCredentialOperations,
  type CredentialRecord,
  type OpenAiAccountRecord,
  ProviderCredentialsError,
} from "@rika/product-store/provider-credentials"
import type { HostedOwner } from "@rika/product/hosted-model"
import { Clock, Context, Crypto, DateTime, Effect, Layer, Option, Redacted, Schema } from "effect"
import type { AuthenticatedPrincipal } from "../product"
import { SecretCipherService, layer as secretCipherLayer } from "../../security/secret-cipher"

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

export type HostedOpenAiAccountStatus =
  | { readonly state: "missing" }
  | {
      readonly state: "active" | "revoked"
      readonly revision: string
      readonly credentialIdentity: string
      readonly fingerprint: string
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
  readonly putOpenAiAccount: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: HostedOwner
    readonly accessToken: Redacted.Redacted<string>
    readonly idToken: Redacted.Redacted<string>
    readonly refreshToken: Redacted.Redacted<string>
  }) => Effect.Effect<Exclude<HostedOpenAiAccountStatus, { readonly state: "missing" }>, HostedProviderCredentialError>
  readonly revokeOpenAiAccount: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: HostedOwner
  }) => Effect.Effect<HostedOpenAiAccountStatus, HostedProviderCredentialError>
  readonly openAiAccountStatus: (input: {
    readonly principal: AuthenticatedPrincipal
    readonly owner: HostedOwner
  }) => Effect.Effect<HostedOpenAiAccountStatus, HostedProviderCredentialError>
  readonly requireOpenAiAccount: (
    ownerId: string,
  ) => Effect.Effect<Exclude<HostedOpenAiAccountStatus, { readonly state: "missing" }>, HostedProviderCredentialError>
  readonly openAiAccountAccess: (credentialIdentity: string) => OpenAiAuth.CredentialAccess
}

export class HostedProviderCredentials extends Context.Service<
  HostedProviderCredentials,
  HostedProviderCredentialsService
>()("@rika/api/hosted/environment/provider-credentials/HostedProviderCredentials") {}

const rejected = (kind: HostedProviderCredentialError["kind"], message: string) =>
  HostedProviderCredentialError.make({ kind, message })
const unavailable = () => rejected("unavailable", "Provider credential service is unavailable")
const storeError = (kind: ProviderCredentialStoreError["kind"], message: string) =>
  ProviderCredentialStoreError.make({ kind, message })
const openAiStoreError = (kind: OpenAiAuthContract.StoreError["kind"], message: string) =>
  OpenAiAuthContract.StoreError.make({ kind, message })
const mapDatabaseError = (error: ProviderCredentialsError) => {
  if (error.kind === "forbidden") return rejected("forbidden", error.message)
  if (error.kind === "missing") return rejected("missing", error.message)
  return unavailable()
}
const ownerReference = (owner: HostedOwner) =>
  owner._tag === "PersonalOwner"
    ? { kind: "personal" as const, userId: owner.userId }
    : { kind: "organization" as const, organizationId: owner.organizationId }
const identity = (row: CredentialRecord): HostedProviderCredentialStatus => ({
  provider: row.provider,
  state: row.status,
  revision: row.revision,
  credentialIdentity: row.credentialIdentity,
})
const openAiAccountIdentity = (
  row: OpenAiAccountRecord,
): Exclude<HostedOpenAiAccountStatus, { readonly state: "missing" }> => ({
  state: row.status,
  revision: row.revision,
  credentialIdentity: row.credentialIdentity,
  fingerprint: row.fingerprint,
})
const now = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.makeUnsafe(millis)),
  Effect.map(DateTime.toDateUtc),
)

export const layer = (options: { readonly encryptionKey: Redacted.Redacted<string> }) =>
  Layer.effect(
    HostedProviderCredentials,
    Effect.gen(function* () {
      const database = yield* makeProviderCredentialOperations
      const crypto = yield* Crypto.Crypto
      const openAiHttp = yield* OpenAiAuth.Http
      const cipher = yield* SecretCipherService
      const authorizedOwnerId = (principal: AuthenticatedPrincipal, owner: HostedOwner) =>
        database.authorizedOwnerId(principal.userId, ownerReference(owner)).pipe(Effect.mapError(mapDatabaseError))
      const decodeOpenAiAccount = (row: OpenAiAccountRecord) => {
        if (row.keyVersion !== 1 || row.nonce === null || row.ciphertext === null || row.authenticationTag === null)
          return Effect.fail(openAiStoreError("corrupt", "OpenAI account credential record is corrupt"))
        const { nonce, ciphertext, authenticationTag } = row
        return Effect.try({
          try: () =>
            cipher.decrypt(`${row.ownerId}/openai-account`, {
              keyVersion: 1,
              nonce,
              ciphertext,
              authenticationTag,
            }),
          catch: () => openAiStoreError("corrupt", "OpenAI account credential cannot be decrypted"),
        }).pipe(
          Effect.flatMap((value) =>
            Schema.decodeEffect(Schema.fromJsonString(OpenAiAuthContract.CredentialDisk))(Redacted.value(value)).pipe(
              Effect.mapError(() => openAiStoreError("corrupt", "OpenAI account credential is corrupt")),
            ),
          ),
          Effect.filterOrFail(
            (value) => value.fingerprint === row.fingerprint,
            () => openAiStoreError("corrupt", "OpenAI account credential identity is corrupt"),
          ),
        )
      }
      const openAiAccountStore = (credentialIdentity: string): OpenAiAuth.StoreInterface => ({
        load: database.openAiAccountByIdentity(credentialIdentity).pipe(
          Effect.mapError(() => openAiStoreError("io", "OpenAI account credential load failed")),
          Effect.flatMap((row) =>
            row === undefined || row.status === "revoked"
              ? Effect.succeed(Option.none())
              : decodeOpenAiAccount(row).pipe(Effect.map(Option.some)),
          ),
        ),
        save: (credential) =>
          Effect.gen(function* () {
            const row = yield* database
              .openAiAccountByIdentity(credentialIdentity)
              .pipe(Effect.mapError(() => openAiStoreError("io", "OpenAI account credential load failed")))
            if (row === undefined || row.status === "revoked")
              return yield* openAiStoreError("missing", "OpenAI account credential is unavailable")
            if (credential.fingerprint !== row.fingerprint)
              return yield* openAiStoreError("unsafe", "OpenAI account changed during refresh")
            const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OpenAiAuthContract.CredentialDisk))(
              credential,
            ).pipe(Effect.mapError(() => openAiStoreError("corrupt", "OpenAI account credential is corrupt")))
            const encrypted = cipher.encrypt(`${row.ownerId}/openai-account`, Redacted.make(encoded))
            const saved = yield* database
              .saveOpenAiAccount(credentialIdentity, credential.fingerprint, encrypted, yield* now)
              .pipe(
                Effect.mapError(() => openAiStoreError("io", "OpenAI account credential refresh could not be saved")),
              )
            if (!saved) return yield* openAiStoreError("missing", "OpenAI account credential is unavailable")
          }),
        remove: database
          .revokeOpenAiAccountByIdentity(credentialIdentity)
          .pipe(Effect.mapError(() => openAiStoreError("io", "OpenAI account credential could not be revoked"))),
        serialized: (effect) =>
          database
            .serializedOpenAiAccount(credentialIdentity, () => effect)
            .pipe(
              Effect.mapError((error) => {
                if (Schema.is(OpenAiAuthContract.StoreError)(error)) return error
                if (Schema.is(ProviderCredentialsError)(error) && error.kind === "missing")
                  return openAiStoreError("missing", error.message)
                return openAiStoreError("io", "OpenAI account credential operation failed")
              }),
            ),
      })
      return HostedProviderCredentials.of({
        put: Effect.fn("HostedProviderCredentials.put")(function* (input) {
          if (Redacted.value(input.apiKey).trim().length === 0)
            return yield* rejected("invalid", "Provider credential must not be empty")
          const ownerId = yield* authorizedOwnerId(input.principal, input.owner)
          const credentialReferenceId = `provider-credential-${yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable))}`
          const row = yield* database
            .putCredential({
              credentialReferenceId,
              ownerId,
              provider: input.provider,
              actorUserId: input.principal.userId,
              encrypted: cipher.encrypt(`${ownerId}/${input.provider}`, input.apiKey),
              matches: (current) => {
                if (
                  current.status !== "active" ||
                  current.keyVersion !== 1 ||
                  current.nonce === null ||
                  current.ciphertext === null ||
                  current.authenticationTag === null
                )
                  return false
                try {
                  const stored = cipher.decrypt(`${ownerId}/${input.provider}`, {
                    keyVersion: 1,
                    nonce: current.nonce,
                    ciphertext: current.ciphertext,
                    authenticationTag: current.authenticationTag,
                  })
                  return Redacted.value(stored) === Redacted.value(input.apiKey)
                } catch {
                  return false
                }
              },
              now: yield* now,
            })
            .pipe(Effect.mapError(mapDatabaseError))
          return identity(row)
        }),
        revoke: Effect.fn("HostedProviderCredentials.revoke")(function* (input) {
          const ownerId = yield* authorizedOwnerId(input.principal, input.owner)
          const row = yield* database
            .revokeCredential(ownerId, input.provider, yield* now)
            .pipe(Effect.mapError(mapDatabaseError))
          if (row === undefined) return yield* rejected("missing", "Provider credential is not configured")
          return identity(row)
        }),
        list: Effect.fn("HostedProviderCredentials.list")(function* (input) {
          const ownerId = yield* authorizedOwnerId(input.principal, input.owner)
          return (yield* database.listCredentials(ownerId).pipe(Effect.mapError(mapDatabaseError))).map(identity)
        }),
        require: Effect.fn("HostedProviderCredentials.require")(function* (ownerId, provider) {
          const row = yield* database.credentialByOwner(ownerId, provider).pipe(Effect.mapError(mapDatabaseError))
          if (row === undefined) return yield* rejected("missing", "Provider credential is not configured")
          if (row.status === "revoked") return yield* rejected("revoked", "Provider credential is revoked")
          return identity(row)
        }),
        putOpenAiAccount: Effect.fn("HostedProviderCredentials.putOpenAiAccount")(function* (input) {
          const ownerId = yield* authorizedOwnerId(input.principal, input.owner)
          const value = yield* OpenAiAuth.credentialFromTokens({ crypto, tokens: input }).pipe(
            Effect.mapError(() => rejected("invalid", "OpenAI account credential is invalid")),
          )
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(OpenAiAuthContract.CredentialDisk))(
            value,
          ).pipe(Effect.mapError(() => rejected("invalid", "OpenAI account credential is invalid")))
          const credentialReferenceId = `openai-account-${yield* crypto.randomUUIDv4.pipe(Effect.mapError(unavailable))}`
          const row = yield* database
            .putOpenAiAccount({
              credentialReferenceId,
              ownerId,
              actorUserId: input.principal.userId,
              fingerprint: value.fingerprint,
              encrypted: cipher.encrypt(`${ownerId}/openai-account`, Redacted.make(encoded)),
              now: yield* now,
            })
            .pipe(Effect.mapError(mapDatabaseError))
          return openAiAccountIdentity(row)
        }),
        revokeOpenAiAccount: Effect.fn("HostedProviderCredentials.revokeOpenAiAccount")(function* (input) {
          const ownerId = yield* authorizedOwnerId(input.principal, input.owner)
          const row = yield* database
            .revokeOpenAiAccountByOwner(ownerId, yield* now)
            .pipe(Effect.mapError(mapDatabaseError))
          return row === undefined ? { state: "missing" as const } : openAiAccountIdentity(row)
        }),
        openAiAccountStatus: Effect.fn("HostedProviderCredentials.openAiAccountStatus")(function* (input) {
          const ownerId = yield* authorizedOwnerId(input.principal, input.owner)
          const row = yield* database.openAiAccountByOwner(ownerId).pipe(Effect.mapError(mapDatabaseError))
          return row === undefined ? { state: "missing" as const } : openAiAccountIdentity(row)
        }),
        requireOpenAiAccount: Effect.fn("HostedProviderCredentials.requireOpenAiAccount")(function* (ownerId) {
          const row = yield* database.openAiAccountByOwner(ownerId).pipe(Effect.mapError(mapDatabaseError))
          if (row === undefined) return yield* rejected("missing", "OpenAI account is not connected")
          if (row.status === "revoked") return yield* rejected("revoked", "OpenAI account connection is revoked")
          return openAiAccountIdentity(row)
        }),
        openAiAccountAccess: (credentialIdentity) =>
          OpenAiAuth.makeCredentialAccess({ store: openAiAccountStore(credentialIdentity), http: openAiHttp, crypto }),
      })
    }),
  ).pipe(Layer.provide(secretCipherLayer({ encodedKey: options.encryptionKey, domain: "provider-credential" })))

export const storeLayer = (options: { readonly encryptionKey: Redacted.Redacted<string> }) =>
  Layer.effect(
    ProviderCredentialStore,
    Effect.gen(function* () {
      const database = yield* makeProviderCredentialOperations
      const cipher = yield* SecretCipherService
      return ProviderCredentialStore.of({
        load: (credentialIdentity) =>
          database.credentialByIdentity(credentialIdentity).pipe(
            Effect.mapError(() => storeError("io", "Provider credential load failed")),
            Effect.flatMap((row) => {
              if (row === undefined || row.status === "revoked") return Effect.succeed(Option.none())
              if (
                row.keyVersion !== 1 ||
                row.nonce === null ||
                row.ciphertext === null ||
                row.authenticationTag === null
              )
                return Effect.fail(storeError("corrupt", "Provider credential record is corrupt"))
              const { nonce, ciphertext, authenticationTag } = row
              return Effect.try({
                try: () =>
                  Option.some(
                    cipher.decrypt(`${row.ownerId}/${row.provider}`, {
                      keyVersion: 1,
                      nonce,
                      ciphertext,
                      authenticationTag,
                    }),
                  ),
                catch: () => storeError("corrupt", "Provider credential cannot be decrypted"),
              })
            }),
          ),
        save: () => Effect.fail(storeError("unsafe", "Provider credentials require an authenticated write")),
        remove: () => Effect.fail(storeError("unsafe", "Provider credentials require an authenticated revoke")),
      })
    }),
  ).pipe(Layer.provide(secretCipherLayer({ encodedKey: options.encryptionKey, domain: "provider-credential" })))
