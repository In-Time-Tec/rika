import * as PgClient from "@effect/sql-pg/PgClient"
import {
  HostedClientAuthority,
  type AuthenticateClientInput,
  type HostedClientAuthorityService,
  type ReadHostedThreadInput,
  type RegisterDeviceInput,
} from "@rika/product/hosted-client-authority"
import { AuthenticatedClient, AuthenticatedDevice, HostedThread } from "@rika/product/hosted-model"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { aliasedTable, and, eq, gt, isNotNull, isNull, or, sql, type SQLWrapper } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { pgTable, text } from "drizzle-orm/pg-core"
import { Effect, Layer, Schema } from "effect"
import type { Row as SqlRow } from "effect/unstable/sql/SqlConnection"
import {
  rikaHostedClientAuthorities,
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedOwners,
  rikaHostedThreads,
} from "../database/schema/product"
import { requireThreadAccess } from "./authority"

const identityMembers = pgTable("member", {
  id: text().primaryKey(),
  organizationId: text("organization_id").notNull(),
  userId: text("user_id").notNull(),
})
const timestamp = (value: string) => sql<Date>`${value}::timestamptz`
const timestampText = (column: SQLWrapper) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
const databaseError = (cause: unknown) =>
  HostedPersistenceError.make({ reason: "database", message: `PostgreSQL operation failed: ${String(cause)}` })
const failure = (reason: HostedPersistenceError["reason"], message: string) =>
  HostedPersistenceError.make({ reason, message })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const decode = <S extends Schema.Top>(schema: S, value: SqlRow | undefined) =>
  Schema.decodeEffect(schema)(value).pipe(Effect.mapError(databaseError))
const ThreadRow = Schema.Struct({
  id: Schema.String,
  ownerId: Schema.String,
  projectId: Schema.NullOr(Schema.String),
  workspaceId: Schema.String,
  createdByUserId: Schema.String,
  executorKind: Schema.Literals(["orb", "runner"]),
  inheritProjectGrants: Schema.Boolean,
  createdAt: Schema.String,
})

const make = Effect.gen(function* (): Effect.fn.Return<HostedClientAuthorityService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const findThread = Effect.fn("HostedClientAuthority.findThread")(function* (
    threadId: ReadHostedThreadInput["threadId"],
  ) {
    const rows = yield* query(
      db
        .select({
          id: rikaHostedThreads.id,
          ownerId: rikaHostedThreads.ownerId,
          projectId: rikaHostedThreads.projectId,
          workspaceId: rikaHostedThreads.workspaceId,
          createdByUserId: rikaHostedThreads.createdByUserId,
          executorKind: rikaHostedThreads.executorKind,
          inheritProjectGrants: rikaHostedThreads.inheritProjectGrants,
          createdAt: timestampText(rikaHostedThreads.createdAt),
        })
        .from(rikaHostedThreads)
        .where(eq(rikaHostedThreads.id, threadId)),
    )
    if (rows[0] === undefined) return undefined
    const row = yield* decode(ThreadRow, rows[0])
    const thread = {
      id: row.id,
      ownerId: row.ownerId,
      workspaceId: row.workspaceId,
      createdByUserId: row.createdByUserId,
      executorKind: row.executorKind,
      inheritProjectGrants: row.inheritProjectGrants,
      createdAt: row.createdAt,
    }
    return yield* decode(HostedThread, row.projectId === null ? thread : { ...thread, projectId: row.projectId })
  })
  const readThread = Effect.fn("HostedClientAuthority.readThread")(function* (input: ReadHostedThreadInput) {
    const thread = yield* findThread(input.threadId)
    return thread?.ownerId === input.ownerId ? thread : undefined
  })

  const registerDevice = Effect.fn("HostedClientAuthority.registerDevice")(function* (input: RegisterDeviceInput) {
    const rows = yield* query(
      db
        .insert(rikaHostedDevices)
        .values({
          id: input.id,
          userId: input.userId,
          displayName: input.displayName,
          publicKeyFingerprint: input.publicKeyFingerprint,
          createdAt: timestamp(input.now),
          lastSeenAt: timestamp(input.now),
        })
        .onConflictDoUpdate({
          target: rikaHostedDevices.id,
          set: {
            displayName: sql`excluded.display_name`,
            publicKeyFingerprint: sql`excluded.public_key_fingerprint`,
            lastSeenAt: sql`excluded.last_seen_at`,
          },
          setWhere: and(
            eq(rikaHostedDevices.userId, sql<string>`excluded.user_id`),
            isNull(rikaHostedDevices.revokedAt),
          )!,
        })
        .returning({
          id: rikaHostedDevices.id,
          userId: rikaHostedDevices.userId,
          displayName: rikaHostedDevices.displayName,
          publicKeyFingerprint: rikaHostedDevices.publicKeyFingerprint,
          createdAt: timestampText(rikaHostedDevices.createdAt),
          lastSeenAt: timestampText(rikaHostedDevices.lastSeenAt),
          revokedAt: sql<null>`NULL`,
        }),
    )
    if (rows[0] === undefined) return yield* failure("invalid-authority", "Device identity cannot be reassigned")
    return yield* decode(AuthenticatedDevice, rows[0])
  })

  const authenticateClient = Effect.fn("HostedClientAuthority.authenticateClient")(function* (
    input: AuthenticateClientInput,
  ) {
    const now = timestamp(input.now)
    const expiresAt = timestamp(input.expiresAt)
    const deviceRecord = aliasedTable(rikaHostedDevices, "device_record")
    const rows = yield* query(
      db
        .insert(rikaHostedClients)
        .select(
          db
            .select({
              id: sql<string>`${input.id}`.as("id"),
              userId: sql<string>`${input.userId}`.as("user_id"),
              deviceId: sql<string>`"device_record"."id"`.as("device_id"),
              authenticatedAt: sql<Date>`${now}`.as("authenticated_at"),
              lastSeenAt: sql<Date>`${now}`.as("last_seen_at"),
              expiresAt: sql<Date>`${expiresAt}`.as("expires_at"),
              revokedAt: sql<null>`null`.as("revoked_at"),
            })
            .from(deviceRecord)
            .where(
              and(
                eq(deviceRecord.id, input.deviceId),
                eq(deviceRecord.userId, input.userId),
                isNull(deviceRecord.revokedAt),
                sql`${expiresAt} > ${now}`,
                sql`${expiresAt}::timestamptz <= ${now}::timestamptz + interval '5 minutes'`,
              ),
            ),
        )
        .onConflictDoUpdate({
          target: rikaHostedClients.id,
          set: {
            authenticatedAt: sql`excluded.authenticated_at`,
            lastSeenAt: sql`excluded.last_seen_at`,
            expiresAt: sql`excluded.expires_at`,
          },
          setWhere: and(
            eq(rikaHostedClients.userId, sql<string>`excluded.user_id`),
            eq(rikaHostedClients.deviceId, sql<string>`excluded.device_id`),
            isNull(rikaHostedClients.revokedAt),
          )!,
        })
        .returning({
          id: rikaHostedClients.id,
          userId: rikaHostedClients.userId,
          deviceId: rikaHostedClients.deviceId,
          authenticatedAt: timestampText(rikaHostedClients.authenticatedAt),
          lastSeenAt: timestampText(rikaHostedClients.lastSeenAt),
          expiresAt: timestampText(rikaHostedClients.expiresAt),
          revokedAt: sql<null>`null`,
        }),
    )
    if (rows[0] === undefined)
      return yield* failure("invalid-authority", "Client device is inactive, foreign, or exceeds five minutes")
    return yield* decode(AuthenticatedClient, rows[0])
  })

  const grantClientAuthority: HostedClientAuthorityService["grantClientAuthority"] = Effect.fn(
    "HostedClientAuthority.grantClientAuthority",
  )(function* (input) {
    const now = timestamp(input.now)
    const expiresAt = timestamp(input.expiresAt)
    const membershipId = input.actor._tag === "OrganizationActor" ? input.actor.membershipId : null
    const authority = yield* query(
      db
        .insert(rikaHostedClientAuthorities)
        .select(
          db
            .select({
              clientId: rikaHostedClients.id,
              ownerId: rikaHostedOwners.id,
              issuedAt: sql<Date>`${now}`.as("issued_at"),
              expiresAt: sql<Date>`least(${expiresAt}, ${rikaHostedClients.expiresAt})`.as("expires_at"),
              revokedAt: sql<null>`null`.as("revoked_at"),
            })
            .from(rikaHostedOwners)
            .innerJoin(
              rikaHostedClients,
              and(
                eq(rikaHostedClients.id, input.actor.clientId),
                eq(rikaHostedClients.userId, input.actor.userId),
                eq(rikaHostedClients.deviceId, input.actor.deviceId),
                isNull(rikaHostedClients.revokedAt),
                gt(rikaHostedClients.expiresAt, now),
              ),
            )
            .innerJoin(
              rikaHostedDevices,
              and(
                eq(rikaHostedDevices.id, rikaHostedClients.deviceId),
                eq(rikaHostedDevices.userId, rikaHostedClients.userId),
                isNull(rikaHostedDevices.revokedAt),
              ),
            )
            .leftJoin(
              identityMembers,
              and(
                eq(rikaHostedOwners.kind, "organization"),
                eq(identityMembers.organizationId, rikaHostedOwners.organizationId),
                membershipId === null ? undefined : eq(identityMembers.id, membershipId),
                eq(identityMembers.userId, rikaHostedClients.userId),
              ),
            )
            .where(
              and(
                eq(rikaHostedOwners.id, input.ownerId),
                sql`${expiresAt} > ${now}`,
                sql`${expiresAt}::timestamptz <= ${now}::timestamptz + interval '5 minutes'`,
                or(
                  and(
                    eq(rikaHostedOwners.kind, "personal"),
                    eq(sql<string>`${input.actor._tag}`, "PersonalActor"),
                    eq(rikaHostedOwners.userId, rikaHostedClients.userId),
                  ),
                  and(
                    eq(rikaHostedOwners.kind, "organization"),
                    eq(sql<string>`${input.actor._tag}`, "OrganizationActor"),
                    isNotNull(identityMembers.id),
                  ),
                ),
              ),
            ),
        )
        .onConflictDoUpdate({
          target: [rikaHostedClientAuthorities.clientId, rikaHostedClientAuthorities.ownerId],
          set: { issuedAt: sql`excluded.issued_at`, expiresAt: sql`excluded.expires_at`, revokedAt: null },
        })
        .returning({ clientId: rikaHostedClientAuthorities.clientId }),
    )
    if (authority[0] === undefined)
      return yield* failure("invalid-authority", "Client owner authority is inactive or foreign")
  })

  const authorizeThread: HostedClientAuthorityService["authorizeThread"] = Effect.fn(
    "HostedClientAuthority.authorizeThread",
  )((input) =>
    db
      .transaction((tx) => requireThreadAccess(tx, input, input.action, input.at))
      .pipe(Effect.catchTag("SqlError", databaseError)),
  )

  return HostedClientAuthority.of({
    registerDevice,
    authenticateClient,
    grantClientAuthority,
    findThread,
    readThread,
    authorizeThread,
  })
})

export const layer = Layer.effect(HostedClientAuthority, make)
