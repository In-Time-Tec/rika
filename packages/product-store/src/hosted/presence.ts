import * as PgClient from "@effect/sql-pg/PgClient"
import { Presence } from "@rika/product/hosted-model"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import {
  HostedPresence,
  type HostedPresenceService,
  type UpsertHostedPresenceInput,
} from "@rika/product/hosted-presence"
import { and, asc, eq, gt, sql, type SQLWrapper } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Layer, Schema } from "effect"
import { rikaHostedPresence } from "../database/schema/product"
import { requireThreadAccess } from "./authority"

const timestamp = (value: string) => sql<Date>`${value}::timestamptz`
const timestampText = (column: SQLWrapper) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
const databaseError = (cause: unknown) =>
  HostedPersistenceError.make({ reason: "database", message: `PostgreSQL operation failed: ${String(cause)}` })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const decode = <Value>(value: Value) => Schema.decodeUnknownEffect(Presence)(value).pipe(Effect.mapError(databaseError))

const make = Effect.gen(function* (): Effect.fn.Return<HostedPresenceService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const upsert = Effect.fn("HostedPresence.upsert")(function* (input: UpsertHostedPresenceInput) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "presence:update", input.now)
          const rows = yield* query(
            tx
              .insert(rikaHostedPresence)
              .values({
                ownerId: input.ownerId,
                threadId: input.threadId,
                actor: input.actor,
                status: input.status,
                lastSeenAt: timestamp(input.now),
                expiresAt: timestamp(input.expiresAt),
              })
              .onConflictDoUpdate({
                target: [rikaHostedPresence.threadId, rikaHostedPresence.actor],
                set: {
                  status: sql`excluded.status`,
                  lastSeenAt: sql`excluded.last_seen_at`,
                  expiresAt: sql`excluded.expires_at`,
                },
                setWhere: eq(rikaHostedPresence.ownerId, sql<string>`excluded.owner_id`),
              })
              .returning({
                ownerId: rikaHostedPresence.ownerId,
                threadId: rikaHostedPresence.threadId,
                actor: rikaHostedPresence.actor,
                status: rikaHostedPresence.status,
                lastSeenAt: timestampText(rikaHostedPresence.lastSeenAt),
                expiresAt: timestampText(rikaHostedPresence.expiresAt),
              }),
          )
          return yield* decode(rows[0])
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const list: HostedPresenceService["list"] = Effect.fn("HostedPresence.list")(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "presence:view", input.now)
          const rows = yield* query(
            tx
              .select({
                ownerId: rikaHostedPresence.ownerId,
                threadId: rikaHostedPresence.threadId,
                actor: rikaHostedPresence.actor,
                status: rikaHostedPresence.status,
                lastSeenAt: timestampText(rikaHostedPresence.lastSeenAt),
                expiresAt: timestampText(rikaHostedPresence.expiresAt),
              })
              .from(rikaHostedPresence)
              .where(
                and(
                  eq(rikaHostedPresence.ownerId, input.ownerId),
                  eq(rikaHostedPresence.threadId, input.threadId),
                  gt(rikaHostedPresence.expiresAt, timestamp(input.now)),
                ),
              )
              .orderBy(asc(rikaHostedPresence.actor)),
          )
          return yield* Effect.forEach(rows, decode)
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  return HostedPresence.of({ upsert, list })
})

export const layer = Layer.effect(HostedPresence, make)
