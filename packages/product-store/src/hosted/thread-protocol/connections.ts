import { BetterAuthUserId, ClientId, DeviceId, ThreadEventCursor, ThreadVersion, Timestamp } from "@rika/product/hosted-model"
import type { ThreadProtocolStoreService } from "@rika/product/thread-protocol-store"
import { and, eq, gt, gte, isNull, lt, lte, max, min, sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect } from "effect"
import {
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedThreadProtocolCursors,
  rikaHostedThreadProtocolEvents,
  rikaHostedThreadProtocolSnapshots,
  rikaHostedThreadProtocolState,
  rikaHostedThreadSocketTickets,
} from "../../database/schema/product"
import { requireThreadAccess } from "../authority"
import {
  bigintText,
  bigintValue,
  databaseError,
  persistenceErrors,
  query,
  timestampText,
  timestampValue,
} from "./persistence"

export const connectionOperations = (db: PgDrizzle.EffectPgDatabase) => {
  const { failure } = persistenceErrors
  const acknowledgeCursor: ThreadProtocolStoreService["acknowledgeCursor"] = Effect.fn(
    "ThreadProtocolStore.acknowledgeCursor",
  )(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "thread:view", input.acknowledgedAt)
          const states = yield* query(
            tx
              .select({
                ownerId: rikaHostedThreadProtocolState.ownerId,
                threadId: rikaHostedThreadProtocolState.threadId,
                threadVersion: bigintText(rikaHostedThreadProtocolState.version),
                headCursor: bigintText(rikaHostedThreadProtocolState.eventCursor),
              })
              .from(rikaHostedThreadProtocolState)
              .where(
                and(
                  eq(rikaHostedThreadProtocolState.ownerId, input.ownerId),
                  eq(rikaHostedThreadProtocolState.threadId, input.threadId),
                  gte(rikaHostedThreadProtocolState.eventCursor, bigintValue(input.cursor)),
                ),
              ),
          )
          if (states[0] === undefined) return yield* failure("conflict", "Cursor is ahead of the committed Thread log")
          const rows = yield* query(
            tx
              .insert(rikaHostedThreadProtocolCursors)
              .values({
                ownerId: states[0].ownerId,
                threadId: states[0].threadId,
                clientId: input.actor.clientId,
                cursor: bigintValue(input.cursor),
                acknowledgedAt: timestampValue(input.acknowledgedAt),
              })
              .onConflictDoUpdate({
                target: [rikaHostedThreadProtocolCursors.threadId, rikaHostedThreadProtocolCursors.clientId],
                set: {
                  cursor: sql<number>`greatest(${rikaHostedThreadProtocolCursors.cursor}, excluded.cursor)`,
                  acknowledgedAt: timestampValue(input.acknowledgedAt),
                },
              })
              .returning({ cursor: bigintText(rikaHostedThreadProtocolCursors.cursor) }),
          )
          const minimum = tx
            .select({ cursor: min(rikaHostedThreadProtocolCursors.cursor) })
            .from(rikaHostedThreadProtocolCursors)
            .where(
              and(
                eq(rikaHostedThreadProtocolCursors.ownerId, input.ownerId),
                eq(rikaHostedThreadProtocolCursors.threadId, input.threadId),
              ),
            )
          const compact = yield* query(
            tx
              .select({ cursor: bigintText(max(rikaHostedThreadProtocolSnapshots.cursor)) })
              .from(rikaHostedThreadProtocolSnapshots)
              .where(
                and(
                  eq(rikaHostedThreadProtocolSnapshots.ownerId, input.ownerId),
                  eq(rikaHostedThreadProtocolSnapshots.threadId, input.threadId),
                  lte(rikaHostedThreadProtocolSnapshots.cursor, minimum),
                ),
              ),
          )
          const compactCursor = compact[0]?.cursor
          if (compactCursor !== null && compactCursor !== undefined) {
            yield* query(
              tx
                .delete(rikaHostedThreadProtocolEvents)
                .where(
                  and(
                    eq(rikaHostedThreadProtocolEvents.ownerId, input.ownerId),
                    eq(rikaHostedThreadProtocolEvents.threadId, input.threadId),
                    lte(rikaHostedThreadProtocolEvents.cursor, bigintValue(compactCursor)),
                  ),
                )
                .returning({ sequence: rikaHostedThreadProtocolEvents.sequence }),
            )
            yield* query(
              tx
                .delete(rikaHostedThreadProtocolSnapshots)
                .where(
                  and(
                    eq(rikaHostedThreadProtocolSnapshots.ownerId, input.ownerId),
                    eq(rikaHostedThreadProtocolSnapshots.threadId, input.threadId),
                    lt(rikaHostedThreadProtocolSnapshots.cursor, bigintValue(compactCursor)),
                  ),
                )
                .returning({ threadVersion: rikaHostedThreadProtocolSnapshots.threadVersion }),
            )
          }
          return {
            acknowledgedCursor: ThreadEventCursor.make(rows[0]!.cursor),
            headCursor: ThreadEventCursor.make(states[0].headCursor),
            threadVersion: ThreadVersion.make(states[0].threadVersion),
          }
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const issueTicket: ThreadProtocolStoreService["issueTicket"] = Effect.fn("ThreadProtocolStore.issueTicket")((input) =>
    query(
      db.insert(rikaHostedThreadSocketTickets).values({
        id: input.ticketId,
        ticketDigest: input.ticketDigest,
        userId: input.userId,
        clientId: input.clientId,
        deviceId: input.deviceId,
        audience: input.audience,
        expiresAt: timestampValue(input.expiresAt),
        issuedAt: timestampValue(input.issuedAt),
      }),
    ).pipe(Effect.asVoid),
  )

  const redeemTicket: ThreadProtocolStoreService["redeemTicket"] = Effect.fn("ThreadProtocolStore.redeemTicket")(
    function* (input) {
      const rows = yield* db
        .transaction((tx) =>
          query(
            tx
              .update(rikaHostedThreadSocketTickets)
              .set({ consumedAt: timestampValue(input.redeemedAt) })
              .from(rikaHostedClients)
              .innerJoin(
                rikaHostedDevices,
                and(
                  eq(rikaHostedDevices.id, rikaHostedClients.deviceId),
                  eq(rikaHostedDevices.userId, rikaHostedClients.userId),
                  isNull(rikaHostedDevices.revokedAt),
                ),
              )
              .where(
                and(
                  eq(rikaHostedThreadSocketTickets.ticketDigest, input.ticketDigest),
                  eq(rikaHostedThreadSocketTickets.audience, input.audience),
                  isNull(rikaHostedThreadSocketTickets.consumedAt),
                  isNull(rikaHostedThreadSocketTickets.revokedAt),
                  gt(rikaHostedThreadSocketTickets.expiresAt, timestampValue(input.redeemedAt)),
                  eq(rikaHostedClients.id, rikaHostedThreadSocketTickets.clientId),
                  eq(rikaHostedClients.userId, rikaHostedThreadSocketTickets.userId),
                  eq(rikaHostedClients.deviceId, rikaHostedThreadSocketTickets.deviceId),
                  isNull(rikaHostedClients.revokedAt),
                  gt(rikaHostedClients.expiresAt, timestampValue(input.redeemedAt)),
                ),
              )
              .returning({
                ticketId: rikaHostedThreadSocketTickets.id,
                userId: rikaHostedThreadSocketTickets.userId,
                clientId: rikaHostedThreadSocketTickets.clientId,
                deviceId: rikaHostedThreadSocketTickets.deviceId,
                audience: rikaHostedThreadSocketTickets.audience,
                expiresAt: timestampText(rikaHostedThreadSocketTickets.expiresAt),
              }),
          ),
        )
        .pipe(Effect.catchTag("SqlError", databaseError))
      const row = rows[0]
      if (row === undefined) return yield* failure("invalid-authority", "WebSocket ticket is invalid or expired")
      return {
        ticketId: row.ticketId,
        userId: BetterAuthUserId.make(row.userId),
        clientId: ClientId.make(row.clientId),
        deviceId: DeviceId.make(row.deviceId),
        audience: row.audience,
        expiresAt: Timestamp.make(row.expiresAt),
      }
    },
  )

  const revokeTicket: ThreadProtocolStoreService["revokeTicket"] = Effect.fn("ThreadProtocolStore.revokeTicket")(
    (ticketId) =>
      query(
        db
          .update(rikaHostedThreadSocketTickets)
          .set({ revokedAt: sql<Date>`transaction_timestamp()` })
          .where(
            and(
              eq(rikaHostedThreadSocketTickets.id, ticketId),
              isNull(rikaHostedThreadSocketTickets.consumedAt),
              isNull(rikaHostedThreadSocketTickets.revokedAt),
            ),
          )
          .returning({ id: rikaHostedThreadSocketTickets.id }),
      ).pipe(Effect.asVoid),
  )

  return { acknowledgeCursor, issueTicket, redeemTicket, revokeTicket }
}
