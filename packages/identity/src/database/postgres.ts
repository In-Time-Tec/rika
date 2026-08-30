import { asc, eq } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Redacted, Schema } from "effect"
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg"
import type { IdentityDatabaseConfig } from "../config"
import {
  IdentityDirectoryError,
  type Account,
  type AccountUser,
  type IdentityDirectory,
  type OrganizationMembership,
} from "../directory"
import { identityMember, identityOrganization, identityUser } from "./account-schema"

export class PostgresAdapterError extends Schema.TaggedError<PostgresAdapterError>()("PostgresAdapterError", {
  operation: Schema.String,
}) {}

const poolOptions = (config: IdentityDatabaseConfig): PoolConfig => ({
  connectionString: Redacted.value(config.databaseUrl),
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  ssl:
    config.databaseSsl === "disable"
      ? false
      : {
          rejectUnauthorized: config.databaseSsl === "verify-full",
        },
})

export const makePostgresPool = (config: IdentityDatabaseConfig) => new Pool(poolOptions(config))

const postgresError = (operation: string) => () => PostgresAdapterError.make({ operation })

type IdentityDatabase = Pick<PgDrizzle.EffectPgDatabase, "select">

const directoryQuery = <A extends object, E, R>(operation: string, statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(() => IdentityDirectoryError.make({ operation })))

const membershipFromRow = (row: AccountRow): OrganizationMembership | undefined => {
  if (
    row.memberId === null ||
    row.memberRole === null ||
    row.memberCreatedAt === null ||
    row.organizationId === null ||
    row.organizationName === null ||
    row.organizationSlug === null
  )
    return undefined
  return {
    id: row.memberId,
    role: row.memberRole,
    createdAt: row.memberCreatedAt.toISOString(),
    organization: {
      id: row.organizationId,
      name: row.organizationName,
      slug: row.organizationSlug,
      logo: row.organizationLogo,
    },
  }
}

interface AccountRow {
  readonly userId: string
  readonly userName: string
  readonly userEmail: string
  readonly userEmailVerified: boolean
  readonly userImage: string | null
  readonly memberId: string | null
  readonly memberRole: string | null
  readonly memberCreatedAt: Date | null
  readonly organizationId: string | null
  readonly organizationName: string | null
  readonly organizationSlug: string | null
  readonly organizationLogo: string | null
}

const accountFromRows = (rows: ReadonlyArray<AccountRow>): Account | undefined => {
  const first = rows[0]
  if (first === undefined) return undefined
  const user: AccountUser = {
    id: first.userId,
    name: first.userName,
    email: first.userEmail,
    emailVerified: first.userEmailVerified,
    image: first.userImage,
  }
  return {
    user,
    memberships: rows.flatMap((row) => {
      const membership = membershipFromRow(row)
      return membership === undefined ? [] : [membership]
    }),
  }
}

export const makePostgresIdentityDirectory = (db: IdentityDatabase): IdentityDirectory => ({
  ready: directoryQuery("readiness", db.select({ id: identityUser.id }).from(identityUser).limit(1)).pipe(
    Effect.asVoid,
  ),
  account: Effect.fn("PostgresStore.account")((userId: string) =>
    directoryQuery(
      "load account",
      db
        .select({
          userId: identityUser.id,
          userName: identityUser.name,
          userEmail: identityUser.email,
          userEmailVerified: identityUser.emailVerified,
          userImage: identityUser.image,
          memberId: identityMember.id,
          memberRole: identityMember.role,
          memberCreatedAt: identityMember.createdAt,
          organizationId: identityOrganization.id,
          organizationName: identityOrganization.name,
          organizationSlug: identityOrganization.slug,
          organizationLogo: identityOrganization.logo,
        })
        .from(identityUser)
        .leftJoin(identityMember, eq(identityMember.userId, identityUser.id))
        .leftJoin(identityOrganization, eq(identityOrganization.id, identityMember.organizationId))
        .where(eq(identityUser.id, userId))
        .orderBy(asc(identityMember.createdAt)),
    ).pipe(Effect.map(accountFromRows)),
  ),
})

const clientQuery = <Row extends QueryResultRow = never>(
  client: PoolClient,
  operation: string,
  text: string,
  values?: unknown[],
) =>
  Effect.tryPromise({
    try: () => client.query<Row>(text, values),
    catch: postgresError(operation),
  })

export const runMigration = (input: {
  readonly pool: Pool
  readonly id: string
  readonly checksum: string
  readonly sql: string
}) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({ try: () => input.pool.connect(), catch: postgresError("connect for migration") }),
    (client) =>
      Effect.gen(function* () {
        yield* clientQuery(client, "begin migration", "begin")
        yield* clientQuery(client, "lock migrations", "select pg_advisory_xact_lock(hashtext('rika-api-migrations'))")
        yield* clientQuery(
          client,
          "create migration metadata",
          `create table if not exists rika_api_migration (
            id text primary key,
            checksum text not null,
            applied_at timestamptz not null default now()
          )`,
        )
        yield* clientQuery(
          client,
          "add migration checksums",
          "alter table rika_api_migration add column if not exists checksum text",
        )
        const applied = yield* clientQuery<{ readonly checksum: string }>(
          client,
          "check migration",
          "select checksum from rika_api_migration where id = $1",
          [input.id],
        )
        if (applied.rowCount !== 0 && applied.rows[0]?.checksum !== input.checksum) {
          return yield* PostgresAdapterError.make({ operation: `migration checksum mismatch: ${input.id}` })
        }
        if (applied.rowCount === 0) {
          yield* clientQuery(client, `apply migration ${input.id}`, input.sql)
          yield* clientQuery(
            client,
            "record migration",
            "insert into rika_api_migration (id, checksum) values ($1, $2)",
            [input.id, input.checksum],
          )
        }
        yield* clientQuery(client, "commit migration", "commit")
        return applied.rowCount === 0
      }).pipe(Effect.tapError(() => clientQuery(client, "rollback migration", "rollback").pipe(Effect.ignore))),
    (client) => Effect.sync(() => client.release()),
  )

export const closePostgresPool = (pool: Pool) =>
  Effect.tryPromise({ try: () => pool.end(), catch: postgresError("close pool") })
