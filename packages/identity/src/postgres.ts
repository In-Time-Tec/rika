import { Effect, Redacted, Schema } from "effect"
import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg"
import type { IdentityDatabaseConfig } from "./config"
import {
  IdentityDirectoryError,
  type Account,
  type AccountUser,
  type IdentityDirectory,
  type OrganizationMembership,
} from "./identity-directory"

export class PostgresAdapterError extends Schema.TaggedError<PostgresAdapterError>()("PostgresAdapterError", {
  operation: Schema.String,
}) {}

interface AccountRow extends QueryResultRow {
  readonly user_id: string
  readonly user_name: string
  readonly user_email: string
  readonly user_email_verified: boolean
  readonly user_image: string | null
  readonly member_id: string | null
  readonly member_role: string | null
  readonly member_created_at: Date | null
  readonly organization_id: string | null
  readonly organization_name: string | null
  readonly organization_slug: string | null
  readonly organization_logo: string | null
}

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

const query = <Row extends QueryResultRow>(pool: Pool, operation: string, text: string, values?: unknown[]) =>
  Effect.tryPromise({
    try: () => pool.query<Row>(text, values).then((result) => result.rows),
    catch: () => IdentityDirectoryError.make({ operation }),
  })

const membershipFromRow = (row: AccountRow): OrganizationMembership | undefined => {
  if (
    row.member_id === null ||
    row.member_role === null ||
    row.member_created_at === null ||
    row.organization_id === null ||
    row.organization_name === null ||
    row.organization_slug === null
  )
    return undefined
  return {
    id: row.member_id,
    role: row.member_role,
    createdAt: row.member_created_at.toISOString(),
    organization: {
      id: row.organization_id,
      name: row.organization_name,
      slug: row.organization_slug,
      logo: row.organization_logo,
    },
  }
}

const accountFromRows = (rows: ReadonlyArray<AccountRow>): Account | undefined => {
  const first = rows[0]
  if (first === undefined) return undefined
  const user: AccountUser = {
    id: first.user_id,
    name: first.user_name,
    email: first.user_email,
    emailVerified: first.user_email_verified,
    image: first.user_image,
  }
  return {
    user,
    memberships: rows.flatMap((row) => {
      const membership = membershipFromRow(row)
      return membership === undefined ? [] : [membership]
    }),
  }
}

export const makePostgresIdentityDirectory = (pool: Pool): IdentityDirectory => ({
  ready: query(pool, "readiness", "select 1 as ready").pipe(Effect.asVoid),
  account: Effect.fn("PostgresStore.account")((userId: string) =>
    query<AccountRow>(
      pool,
      "load account",
      `select
        u.id as user_id,
        u.name as user_name,
        u.email as user_email,
        u.email_verified as user_email_verified,
        u.image as user_image,
        m.id as member_id,
        m.role as member_role,
        m.created_at as member_created_at,
        o.id as organization_id,
        o.name as organization_name,
        o.slug as organization_slug,
        o.logo as organization_logo
      from "user" u
      left join member m on m.user_id = u.id
      left join organization o on o.id = m.organization_id
      where u.id = $1
      order by m.created_at asc`,
      [userId],
    ).pipe(Effect.map(accountFromRows)),
  ),
})

const clientQuery = (client: PoolClient, operation: string, text: string, values?: unknown[]) =>
  Effect.tryPromise({
    try: () => client.query(text, values),
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
        yield* clientQuery(
          client,
          "lock migrations",
          "select pg_advisory_xact_lock(hashtext('rika-control-plane-migrations'))",
        )
        yield* clientQuery(
          client,
          "create migration metadata",
          `create table if not exists control_plane_migration (
            id text primary key,
            checksum text not null,
            applied_at timestamptz not null default now()
          )`,
        )
        yield* clientQuery(
          client,
          "add migration checksums",
          "alter table control_plane_migration add column if not exists checksum text",
        )
        const applied = yield* clientQuery(
          client,
          "check migration",
          "select checksum from control_plane_migration where id = $1",
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
            "insert into control_plane_migration (id, checksum) values ($1, $2)",
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
