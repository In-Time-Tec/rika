import * as PgClient from "@effect/sql-pg/PgClient"
import { ThreadProtocolStore, type ThreadProtocolStoreService } from "@rika/product/thread-protocol-store"
import { and, eq } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Layer } from "effect"
import { rikaHostedThreadProtocolState, rikaHostedThreads } from "../database/schema/product"
import { requireThreadReadAccess } from "./authority"
import { commandOperations } from "./thread-protocol/commands"
import { connectionOperations } from "./thread-protocol/connections"
import { eventOperations } from "./thread-protocol/events"
import { databaseError, persistenceErrors, query } from "./thread-protocol/persistence"

const make = Effect.gen(function* (): Effect.fn.Return<ThreadProtocolStoreService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()
  const { failure } = persistenceErrors

  const initializeThread: ThreadProtocolStoreService["initializeThread"] = Effect.fn(
    "ThreadProtocolStore.initializeThread",
  )(function* (input) {
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadReadAccess(tx, input)
          const threads = yield* query(
            tx
              .select({ ownerId: rikaHostedThreads.ownerId, threadId: rikaHostedThreads.id })
              .from(rikaHostedThreads)
              .where(and(eq(rikaHostedThreads.ownerId, input.ownerId), eq(rikaHostedThreads.id, input.threadId))),
          )
          if (threads[0] === undefined) return yield* failure("not-found", "Thread is unavailable")
          const rows = yield* query(
            tx
              .insert(rikaHostedThreadProtocolState)
              .values(threads[0])
              .onConflictDoUpdate({
                target: rikaHostedThreadProtocolState.threadId,
                set: { ownerId: threads[0].ownerId },
                setWhere: eq(rikaHostedThreadProtocolState.ownerId, threads[0].ownerId),
              })
              .returning({ threadId: rikaHostedThreadProtocolState.threadId }),
          )
          if (rows[0] === undefined) return yield* failure("not-found", "Thread is unavailable")
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const events = eventOperations(db)

  return ThreadProtocolStore.of({
    initializeThread,
    ...commandOperations({ db, events }),
    appendEvents: events.appendEvents,
    checkpoint: events.checkpoint,
    saveSnapshot: events.saveSnapshot,
    replay: events.replay,
    ...connectionOperations(db),
  })
})

export const layer = Layer.effect(ThreadProtocolStore, make)
