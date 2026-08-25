import * as PgDrizzle from "drizzle-orm/effect-postgres"
import * as PgClient from "@effect/sql-pg/PgClient"
import { and, asc, eq, sql as expression } from "drizzle-orm"
import { Effect, Schema } from "effect"
import {
  rikaHostedCredentialReferences,
  rikaHostedOpenaiAccountCredentials,
  rikaHostedOwners,
  rikaHostedProviderCredentials,
} from "../../database/schema/product"

export const Provider = Schema.Literals(["openai", "anthropic", "openrouter"])
export type Provider = typeof Provider.Type
export const CredentialState = Schema.Literals(["active", "revoked"])
export type CredentialState = typeof CredentialState.Type

export class ProviderCredentialsError extends Schema.TaggedError<ProviderCredentialsError>()(
  "ProviderCredentialsError",
  { kind: Schema.Literals(["database", "forbidden", "missing"]), message: Schema.String },
) {}

export interface EncryptedCredential {
  readonly keyVersion: number
  readonly nonce: Uint8Array
  readonly ciphertext: Uint8Array
  readonly authenticationTag: Uint8Array
}

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

export type OwnerReference =
  | { readonly kind: "personal"; readonly userId: string }
  | { readonly kind: "organization"; readonly organizationId: string }

export interface PutCredentialInput {
  readonly credentialReferenceId: string
  readonly ownerId: string
  readonly provider: Provider
  readonly actorUserId: string
  readonly encrypted: EncryptedCredential
  readonly now: Date
}

export interface PutOpenAiAccountInput {
  readonly credentialReferenceId: string
  readonly ownerId: string
  readonly actorUserId: string
  readonly fingerprint: string
  readonly encrypted: EncryptedCredential
  readonly now: Date
}

export interface ProviderCredentialOperations {
  readonly authorizedOwnerId: (
    principalUserId: string,
    owner: OwnerReference,
  ) => Effect.Effect<string, ProviderCredentialsError>
  readonly credentialByOwner: (
    ownerId: string,
    provider: Provider,
  ) => Effect.Effect<CredentialRecord | undefined, ProviderCredentialsError>
  readonly credentialByIdentity: (
    credentialIdentity: string,
  ) => Effect.Effect<CredentialRecord | undefined, ProviderCredentialsError>
  readonly listCredentials: (
    ownerId: string,
  ) => Effect.Effect<ReadonlyArray<CredentialRecord>, ProviderCredentialsError>
  readonly putCredential: (input: PutCredentialInput) => Effect.Effect<CredentialRecord, ProviderCredentialsError>
  readonly revokeCredential: (
    ownerId: string,
    provider: Provider,
    now: Date,
  ) => Effect.Effect<CredentialRecord | undefined, ProviderCredentialsError>
  readonly openAiAccountByOwner: (
    ownerId: string,
  ) => Effect.Effect<OpenAiAccountRecord | undefined, ProviderCredentialsError>
  readonly openAiAccountByIdentity: (
    credentialIdentity: string,
  ) => Effect.Effect<OpenAiAccountRecord | undefined, ProviderCredentialsError>
  readonly putOpenAiAccount: (
    input: PutOpenAiAccountInput,
  ) => Effect.Effect<OpenAiAccountRecord, ProviderCredentialsError>
  readonly saveOpenAiAccount: (
    credentialIdentity: string,
    fingerprint: string,
    encrypted: EncryptedCredential,
    now: Date,
  ) => Effect.Effect<boolean, ProviderCredentialsError>
  readonly revokeOpenAiAccountByOwner: (
    ownerId: string,
    now: Date,
  ) => Effect.Effect<OpenAiAccountRecord | undefined, ProviderCredentialsError>
  readonly revokeOpenAiAccountByIdentity: (
    credentialIdentity: string,
  ) => Effect.Effect<boolean, ProviderCredentialsError>
  readonly serializedOpenAiAccount: <A, E, R>(
    credentialIdentity: string,
    use: () => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ProviderCredentialsError, R>
}

const ProviderMetadata = Schema.Struct({ encryption: Schema.String, keyVersion: Schema.Finite })
const AccountMetadata = Schema.Struct({
  authentication: Schema.String,
  encryption: Schema.String,
  keyVersion: Schema.Finite,
})
const providerMetadata = Schema.decodeSync(ProviderMetadata)({ encryption: "aes-256-gcm", keyVersion: 1 })
const accountMetadata = Schema.decodeSync(AccountMetadata)({
  authentication: "account",
  encryption: "aes-256-gcm",
  keyVersion: 1,
})
const failure = (kind: ProviderCredentialsError["kind"], message: string) =>
  ProviderCredentialsError.make({ kind, message })
const database = () => failure("database", "Provider credential database operation failed")
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(database))
const credentialRecord = Effect.fn("ProviderCredentials.credentialRecord")(function* (
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

const accountRecord = Effect.fn("ProviderCredentials.accountRecord")(function* (
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

const credentialRecords = Effect.forEach(credentialRecord)
const accountRecords = Effect.forEach(accountRecord)

type Executor = PgDrizzle.EffectPgDatabase

const operations = (db: Executor): ProviderCredentialOperations => {
  const credentialByOwner = (ownerId: string, provider: Provider) =>
    query(
      db
        .select()
        .from(rikaHostedProviderCredentials)
        .where(
          and(eq(rikaHostedProviderCredentials.ownerId, ownerId), eq(rikaHostedProviderCredentials.provider, provider)),
        ),
    ).pipe(Effect.flatMap(credentialRecords), Effect.map((rows) => rows[0]))
  const credentialByIdentity = (credentialIdentity: string) =>
    query(
      db
        .select()
        .from(rikaHostedProviderCredentials)
        .where(eq(rikaHostedProviderCredentials.credentialReferenceId, credentialIdentity)),
    ).pipe(Effect.flatMap(credentialRecords), Effect.map((rows) => rows[0]))
  const openAiAccountByOwner = (ownerId: string) =>
    query(
      db
        .select()
        .from(rikaHostedOpenaiAccountCredentials)
        .where(eq(rikaHostedOpenaiAccountCredentials.ownerId, ownerId)),
    ).pipe(Effect.flatMap(accountRecords), Effect.map((rows) => rows[0]))
  const openAiAccountByIdentity = (credentialIdentity: string) =>
    query(
      db
        .select()
        .from(rikaHostedOpenaiAccountCredentials)
        .where(eq(rikaHostedOpenaiAccountCredentials.credentialReferenceId, credentialIdentity)),
    ).pipe(Effect.flatMap(accountRecords), Effect.map((rows) => rows[0]))
  const service: ProviderCredentialOperations = {
    authorizedOwnerId: (principalUserId, owner) => {
      if (owner.kind === "personal" && owner.userId !== principalUserId)
        return Effect.fail(failure("forbidden", "Owner is unavailable"))
      const ownerPredicate =
        owner.kind === "personal"
          ? and(eq(rikaHostedOwners.kind, "personal"), eq(rikaHostedOwners.userId, owner.userId))
          : and(eq(rikaHostedOwners.kind, "organization"), eq(rikaHostedOwners.organizationId, owner.organizationId))
      return query(
        db
          .select({ id: rikaHostedOwners.id })
          .from(rikaHostedOwners)
          .where(
            and(
              ownerPredicate,
              owner.kind === "organization"
                ? expression`exists (select 1 from "member" where organization_id = ${owner.organizationId} and user_id = ${principalUserId} and role in ('owner', 'admin'))`
                : expression`true`,
            ),
          ),
      ).pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.fail(failure("forbidden", "Owner is unavailable"))
            : Effect.succeed(rows[0].id),
        ),
      )
    },
    credentialByOwner,
    credentialByIdentity,
    listCredentials: (ownerId) =>
      query(
        db
          .select()
          .from(rikaHostedProviderCredentials)
          .where(eq(rikaHostedProviderCredentials.ownerId, ownerId))
          .orderBy(asc(rikaHostedProviderCredentials.provider)),
      ).pipe(Effect.flatMap(credentialRecords)),
    putCredential: (input) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const references = yield* query(
              tx
                .insert(rikaHostedCredentialReferences)
                .values({
                  id: input.credentialReferenceId,
                  ownerId: input.ownerId,
                  provider: input.provider,
                  purpose: "model-provider",
                  externalReference: `postgresql://${input.credentialReferenceId}`,
                  metadata: providerMetadata,
                  createdByUserId: input.actorUserId,
                  createdAt: input.now,
                  updatedAt: input.now,
                })
                .onConflictDoUpdate({
                  target: [rikaHostedCredentialReferences.ownerId, rikaHostedCredentialReferences.provider],
                  targetWhere: eq(rikaHostedCredentialReferences.purpose, "model-provider"),
                  set: { metadata: providerMetadata, updatedAt: input.now },
                })
                .returning({ id: rikaHostedCredentialReferences.id }),
            )
            const reference = references[0]
            if (reference === undefined) return yield* database()
            const rows = yield* query(
              tx
                .insert(rikaHostedProviderCredentials)
                .values({
                  credentialReferenceId: reference.id,
                  ownerId: input.ownerId,
                  provider: input.provider,
                  status: "active",
                  revision: 1,
                  ...input.encrypted,
                  createdAt: input.now,
                  updatedAt: input.now,
                  rotatedAt: null,
                  revokedAt: null,
                })
                .onConflictDoUpdate({
                  target: [rikaHostedProviderCredentials.ownerId, rikaHostedProviderCredentials.provider],
                  set: {
                    status: "active",
                    revision: expression`${rikaHostedProviderCredentials.revision} + 1`,
                    keyVersion: input.encrypted.keyVersion,
                    nonce: input.encrypted.nonce,
                    ciphertext: input.encrypted.ciphertext,
                    authenticationTag: input.encrypted.authenticationTag,
                    updatedAt: input.now,
                    rotatedAt: input.now,
                    revokedAt: null,
                  },
                })
                .returning(),
            )
            if (rows[0] === undefined) return yield* database()
            return yield* credentialRecord(rows[0])
          }),
        )
        .pipe(Effect.mapError(database)),
    revokeCredential: (ownerId, provider, now) =>
      query(
        db
          .update(rikaHostedProviderCredentials)
          .set({
            status: "revoked",
            revision: expression`${rikaHostedProviderCredentials.revision} + 1`,
            keyVersion: null,
            nonce: null,
            ciphertext: null,
            authenticationTag: null,
            updatedAt: now,
            revokedAt: now,
          })
          .where(
            and(
              eq(rikaHostedProviderCredentials.ownerId, ownerId),
              eq(rikaHostedProviderCredentials.provider, provider),
            ),
          )
          .returning(),
      ).pipe(Effect.flatMap(credentialRecords), Effect.map((rows) => rows[0])),
    openAiAccountByOwner,
    openAiAccountByIdentity,
    putOpenAiAccount: (input) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const references = yield* query(
              tx
                .insert(rikaHostedCredentialReferences)
                .values({
                  id: input.credentialReferenceId,
                  ownerId: input.ownerId,
                  provider: "openai",
                  purpose: "model-provider-account",
                  externalReference: `postgresql://${input.credentialReferenceId}`,
                  metadata: accountMetadata,
                  createdByUserId: input.actorUserId,
                  createdAt: input.now,
                  updatedAt: input.now,
                })
                .onConflictDoUpdate({
                  target: [rikaHostedCredentialReferences.ownerId, rikaHostedCredentialReferences.provider],
                  targetWhere: eq(rikaHostedCredentialReferences.purpose, "model-provider-account"),
                  set: { metadata: accountMetadata, updatedAt: input.now },
                })
                .returning({ id: rikaHostedCredentialReferences.id }),
            )
            if (references[0] === undefined) return yield* database()
            const rows = yield* query(
              tx
                .insert(rikaHostedOpenaiAccountCredentials)
                .values({
                  credentialReferenceId: references[0].id,
                  ownerId: input.ownerId,
                  provider: "openai",
                  status: "active",
                  revision: 1,
                  fingerprint: input.fingerprint,
                  ...input.encrypted,
                  createdAt: input.now,
                  updatedAt: input.now,
                  rotatedAt: null,
                  revokedAt: null,
                })
                .onConflictDoUpdate({
                  target: rikaHostedOpenaiAccountCredentials.ownerId,
                  set: {
                    status: "active",
                    revision: expression`${rikaHostedOpenaiAccountCredentials.revision} + 1`,
                    fingerprint: input.fingerprint,
                    keyVersion: input.encrypted.keyVersion,
                    nonce: input.encrypted.nonce,
                    ciphertext: input.encrypted.ciphertext,
                    authenticationTag: input.encrypted.authenticationTag,
                    updatedAt: input.now,
                    rotatedAt: input.now,
                    revokedAt: null,
                  },
                })
                .returning(),
            )
            if (rows[0] === undefined) return yield* database()
            return yield* accountRecord(rows[0])
          }),
        )
        .pipe(Effect.mapError(database)),
    saveOpenAiAccount: (credentialIdentity, fingerprint, encrypted, now) =>
      query(
        db
          .update(rikaHostedOpenaiAccountCredentials)
          .set({
            revision: expression`${rikaHostedOpenaiAccountCredentials.revision} + 1`,
            ...encrypted,
            updatedAt: now,
            rotatedAt: now,
          })
          .where(
            and(
              eq(rikaHostedOpenaiAccountCredentials.credentialReferenceId, credentialIdentity),
              eq(rikaHostedOpenaiAccountCredentials.fingerprint, fingerprint),
              eq(rikaHostedOpenaiAccountCredentials.status, "active"),
            ),
          )
          .returning({ id: rikaHostedOpenaiAccountCredentials.credentialReferenceId }),
      ).pipe(Effect.map((rows) => rows[0] !== undefined)),
    revokeOpenAiAccountByOwner: (ownerId, now) =>
      query(
        db
          .update(rikaHostedOpenaiAccountCredentials)
          .set({
            status: "revoked",
            revision: expression`${rikaHostedOpenaiAccountCredentials.revision} + 1`,
            keyVersion: null,
            nonce: null,
            ciphertext: null,
            authenticationTag: null,
            updatedAt: now,
            revokedAt: now,
          })
          .where(eq(rikaHostedOpenaiAccountCredentials.ownerId, ownerId))
          .returning(),
      ).pipe(Effect.flatMap(accountRecords), Effect.map((rows) => rows[0])),
    revokeOpenAiAccountByIdentity: (credentialIdentity) =>
      query(
        db
          .update(rikaHostedOpenaiAccountCredentials)
          .set({
            status: "revoked",
            revision: expression`${rikaHostedOpenaiAccountCredentials.revision} + 1`,
            keyVersion: null,
            nonce: null,
            ciphertext: null,
            authenticationTag: null,
            updatedAt: expression`transaction_timestamp()`,
            revokedAt: expression`transaction_timestamp()`,
          })
          .where(
            and(
              eq(rikaHostedOpenaiAccountCredentials.credentialReferenceId, credentialIdentity),
              eq(rikaHostedOpenaiAccountCredentials.status, "active"),
            ),
          )
          .returning({ id: rikaHostedOpenaiAccountCredentials.credentialReferenceId }),
      ).pipe(Effect.map((rows) => rows[0] !== undefined)),
    serializedOpenAiAccount: <A, E, R>(
      credentialIdentity: string,
      use: () => Effect.Effect<A, E, R>,
    ) =>
      db
        .transaction<A, E | ProviderCredentialsError, R>((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx
              .select({ id: rikaHostedOpenaiAccountCredentials.credentialReferenceId })
              .from(rikaHostedOpenaiAccountCredentials)
              .where(eq(rikaHostedOpenaiAccountCredentials.credentialReferenceId, credentialIdentity))
              .for("update")
              .pipe(Effect.mapError(database))
            if (rows[0] === undefined)
              return yield* failure("missing", "OpenAI account credential is unavailable")
            return yield* use()
          }),
        )
        .pipe(Effect.catchTag("SqlError", database)),
  }
  return service
}

export const make = Effect.gen(function* () {
  yield* PgClient.PgClient
  return operations(yield* PgDrizzle.makeWithDefaults())
})
