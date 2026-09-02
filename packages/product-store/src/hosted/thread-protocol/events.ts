import { HostedThreadSnapshot } from "@rika/product/client-protocol"
import { OwnerId, ThreadEventCursor, ThreadId, ThreadVersion, Timestamp } from "@rika/product/hosted-model"
import { InteractiveEventSchema } from "@rika/product/interactive-event"
import type { ThreadProtocolEvent, ThreadProtocolStoreService } from "@rika/product/thread-protocol-store"
import { and, asc, desc, eq, gt, gte, lte, sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect } from "effect"
import {
  rikaHostedThreadProtocolEvents,
  rikaHostedThreadProtocolSnapshots,
  rikaHostedThreadProtocolState,
} from "../../database/schema/product"
import { requireThreadAccess } from "../authority"
import {
  bigintText,
  bigintValue,
  databaseError,
  decode,
  persistenceErrors,
  protocolEquivalence,
  query,
  timestampText,
  timestampValue,
} from "./persistence"

const checkpointInterval = 64n

type ReplayInput = Parameters<ThreadProtocolStoreService["replay"]>[0]

const replayCheckpointCondition = (input: ReplayInput, targetCursor: ThreadEventCursor, retainedTail: boolean) => {
  if (!retainedTail) return undefined
  const lowerBound =
    input.afterCheckpointCursor === undefined
      ? gte(rikaHostedThreadProtocolSnapshots.cursor, bigintValue(input.afterCursor))
      : gt(rikaHostedThreadProtocolSnapshots.cursor, bigintValue(input.afterCheckpointCursor))
  return and(
    eq(rikaHostedThreadProtocolSnapshots.replayRequired, true),
    lowerBound,
    lte(rikaHostedThreadProtocolSnapshots.cursor, bigintValue(targetCursor)),
  )
}

const replaySnapshotCondition = (replayCursor: ThreadEventCursor, targetCursor: ThreadEventCursor) =>
  replayCursor === "0"
    ? lte(rikaHostedThreadProtocolSnapshots.cursor, bigintValue(targetCursor))
    : and(
        gt(rikaHostedThreadProtocolSnapshots.cursor, bigintValue(replayCursor)),
        lte(rikaHostedThreadProtocolSnapshots.cursor, bigintValue(targetCursor)),
      )

const isDirectReplayTail = (
  replayCursor: ThreadEventCursor,
  targetCursor: ThreadEventCursor,
  firstEventCursor: string | undefined,
) => BigInt(replayCursor) === BigInt(targetCursor) || firstEventCursor === (BigInt(replayCursor) + 1n).toString()

const isRetainedReplayTail = (input: ReplayInput, directTail: boolean) =>
  directTail && (input.afterCursor !== "0" || input.afterCheckpointCursor !== undefined)

const skipReplaySnapshot = (input: ReplayInput, retainedTail: boolean, hasRequiredCheckpoint: boolean) =>
  input.includeSnapshot === false || (retainedTail && !hasRequiredCheckpoint)

export const eventOperations = (db: PgDrizzle.EffectPgDatabase) => {
  const { failure } = persistenceErrors
  const { pendingAuthorizations: pendingAuthorizationsEquivalent } = protocolEquivalence
  const writeEvents = Effect.fn("ThreadProtocolStore.writeEvents")(function* (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    input: {
      readonly ownerId: OwnerId
      readonly threadId: ThreadId
      readonly threadVersion: ThreadVersion
      readonly firstCursor: bigint
      readonly events: Parameters<ThreadProtocolStoreService["appendEvents"]>[0]["events"]
      readonly createdAt: Timestamp
    },
  ) {
    const written = input.events.map((event, index): ThreadProtocolEvent => {
      const sequence = (input.firstCursor + BigInt(index)).toString()
      return {
        ownerId: input.ownerId,
        threadId: input.threadId,
        sequence,
        cursor: ThreadEventCursor.make(sequence),
        threadVersion: input.threadVersion,
        event,
        createdAt: input.createdAt,
      }
    })
    if (written.length > 0)
      yield* query(
        tx.insert(rikaHostedThreadProtocolEvents).values(
          written.map((event) => ({
            ownerId: event.ownerId,
            threadId: event.threadId,
            sequence: bigintValue(event.sequence),
            cursor: bigintValue(event.cursor),
            threadVersion: bigintValue(event.threadVersion),
            event: event.event,
            createdAt: timestampValue(event.createdAt),
          })),
        ),
      )
    return written
  })

  const stateForUpdate = (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ownerId: OwnerId,
    threadId: ThreadId,
  ) =>
    query(
      tx
        .select({
          version: bigintText(rikaHostedThreadProtocolState.version),
          cursor: bigintText(rikaHostedThreadProtocolState.eventCursor),
        })
        .from(rikaHostedThreadProtocolState)
        .where(
          and(eq(rikaHostedThreadProtocolState.ownerId, ownerId), eq(rikaHostedThreadProtocolState.threadId, threadId)),
        )
        .for("update"),
    )

  const writeSnapshot = (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    input: {
      readonly ownerId: OwnerId
      readonly threadId: ThreadId
      readonly threadVersion: ThreadVersion
      readonly cursor: ThreadEventCursor
      readonly snapshot: HostedThreadSnapshot
      readonly createdAt: Timestamp
      readonly replayRequired?: boolean
    },
  ) =>
    query(
      tx
        .insert(rikaHostedThreadProtocolSnapshots)
        .values({
          ownerId: input.ownerId,
          threadId: input.threadId,
          threadVersion: bigintValue(input.threadVersion),
          cursor: bigintValue(input.cursor),
          snapshot: input.snapshot,
          replayRequired: input.replayRequired ?? false,
          createdAt: timestampValue(input.createdAt),
        })
        .onConflictDoUpdate({
          target: [rikaHostedThreadProtocolSnapshots.threadId, rikaHostedThreadProtocolSnapshots.threadVersion],
          set: {
            cursor: bigintValue(input.cursor),
            snapshot: input.snapshot,
            replayRequired: sql`${rikaHostedThreadProtocolSnapshots.replayRequired} OR excluded.replay_required`,
            createdAt: timestampValue(input.createdAt),
          },
          setWhere: lte(rikaHostedThreadProtocolSnapshots.cursor, sql<number>`excluded.cursor`),
        }),
    ).pipe(Effect.asVoid)

  const checkpointDue = Effect.fn("ThreadProtocolStore.checkpointDue")(function* (
    tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
    ownerId: OwnerId,
    threadId: ThreadId,
    cursor: ThreadEventCursor,
    snapshot: HostedThreadSnapshot,
  ) {
    const latest = (yield* query(
      tx
        .select({
          cursor: bigintText(rikaHostedThreadProtocolSnapshots.cursor),
          snapshot: rikaHostedThreadProtocolSnapshots.snapshot,
          replayRequired: rikaHostedThreadProtocolSnapshots.replayRequired,
        })
        .from(rikaHostedThreadProtocolSnapshots)
        .where(
          and(
            eq(rikaHostedThreadProtocolSnapshots.ownerId, ownerId),
            eq(rikaHostedThreadProtocolSnapshots.threadId, threadId),
          ),
        )
        .orderBy(desc(rikaHostedThreadProtocolSnapshots.cursor))
        .limit(1),
    ))[0]
    if (latest === undefined) return { due: true, replayRequired: false }
    const stored = yield* decode(HostedThreadSnapshot)(latest.snapshot)
    const authorizationChanged = !pendingAuthorizationsEquivalent(
      stored.pendingAuthorizations,
      snapshot.pendingAuthorizations,
    )
    return {
      due: authorizationChanged || BigInt(cursor) - BigInt(latest.cursor) >= checkpointInterval,
      replayRequired: authorizationChanged || latest.replayRequired,
    }
  })

  const appendEvents: ThreadProtocolStoreService["appendEvents"] = Effect.fn("ThreadProtocolStore.appendEvents")(
    function* (input) {
      if (input.events.length === 0) return []
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const state = (yield* stateForUpdate(tx, input.ownerId, input.threadId))[0]
            if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
            const events = yield* writeEvents(tx, {
              ...input,
              threadVersion: ThreadVersion.make(state.version),
              firstCursor: BigInt(state.cursor) + 1n,
            })
            const cursor = events.at(-1)!.cursor
            yield* query(
              tx
                .update(rikaHostedThreadProtocolState)
                .set({ eventCursor: bigintValue(cursor) })
                .where(
                  and(
                    eq(rikaHostedThreadProtocolState.ownerId, input.ownerId),
                    eq(rikaHostedThreadProtocolState.threadId, input.threadId),
                  ),
                ),
            )
            if (input.snapshot !== undefined) {
              const decision = yield* checkpointDue(tx, input.ownerId, input.threadId, cursor, input.snapshot)
              if (decision.due)
                yield* writeSnapshot(tx, {
                  ownerId: input.ownerId,
                  threadId: input.threadId,
                  threadVersion: ThreadVersion.make(state.version),
                  cursor,
                  snapshot: input.snapshot,
                  createdAt: input.createdAt,
                  replayRequired: decision.replayRequired,
                })
            }
            return events
          }),
        )
        .pipe(Effect.catchTag("SqlError", databaseError))
    },
  )

  const checkpoint: ThreadProtocolStoreService["checkpoint"] = Effect.fn("ThreadProtocolStore.checkpoint")(
    function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const state = (yield* stateForUpdate(tx, input.ownerId, input.threadId))[0]
            if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
            if (state.version !== input.threadVersion || state.cursor !== input.cursor)
              return yield* failure("conflict", "Thread protocol state advanced before its checkpoint was persisted")
            const decision = yield* checkpointDue(tx, input.ownerId, input.threadId, input.cursor, input.snapshot)
            if (!decision.due) return false
            yield* writeSnapshot(tx, { ...input, replayRequired: decision.replayRequired })
            return true
          }),
        )
        .pipe(Effect.catchTag("SqlError", databaseError))
    },
  )

  const saveSnapshot: ThreadProtocolStoreService["saveSnapshot"] = Effect.fn("ThreadProtocolStore.saveSnapshot")(
    function* (input) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* query(
              tx
                .select({ threadId: rikaHostedThreadProtocolState.threadId })
                .from(rikaHostedThreadProtocolState)
                .where(
                  and(
                    eq(rikaHostedThreadProtocolState.ownerId, input.ownerId),
                    eq(rikaHostedThreadProtocolState.threadId, input.threadId),
                    eq(rikaHostedThreadProtocolState.version, bigintValue(input.threadVersion)),
                    eq(rikaHostedThreadProtocolState.eventCursor, bigintValue(input.cursor)),
                  ),
                )
                .for("update"),
            )
            if (rows[0] === undefined)
              return yield* failure("conflict", "Thread protocol state advanced before its snapshot was persisted")
            yield* writeSnapshot(tx, input)
          }),
        )
        .pipe(Effect.catchTag("SqlError", databaseError))
    },
  )

  const replay: ThreadProtocolStoreService["replay"] = Effect.fn("ThreadProtocolStore.replay")(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "thread:view")
          const state = (yield* query(
            tx
              .select({
                version: bigintText(rikaHostedThreadProtocolState.version),
                cursor: bigintText(rikaHostedThreadProtocolState.eventCursor),
              })
              .from(rikaHostedThreadProtocolState)
              .where(
                and(
                  eq(rikaHostedThreadProtocolState.ownerId, input.ownerId),
                  eq(rikaHostedThreadProtocolState.threadId, input.threadId),
                ),
              ),
          ))[0]
          if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
          const stateCursor = BigInt(state.cursor)
          const throughCursor = input.throughCursor === undefined ? stateCursor : BigInt(input.throughCursor)
          const targetCursor = ThreadEventCursor.make(
            (throughCursor < stateCursor ? throughCursor : stateCursor).toString(),
          )
          if (BigInt(input.afterCursor) > BigInt(targetCursor))
            return yield* failure("conflict", "Replay cursor is ahead of the committed Thread log")
          if (
            input.afterCheckpointCursor !== undefined &&
            BigInt(input.afterCheckpointCursor) > BigInt(input.afterCursor)
          )
            return yield* failure("conflict", "Replay checkpoint cursor is ahead of its event cursor")
          const limit = Math.min(Math.max(Math.trunc(input.limit), 1), 1_000)
          const readEvents = (cursor: ThreadEventCursor) =>
            query(
              tx
                .select({
                  sequence: bigintText(rikaHostedThreadProtocolEvents.sequence),
                  cursor: bigintText(rikaHostedThreadProtocolEvents.cursor),
                  threadVersion: bigintText(rikaHostedThreadProtocolEvents.threadVersion),
                  event: rikaHostedThreadProtocolEvents.event,
                  createdAt: timestampText(rikaHostedThreadProtocolEvents.createdAt),
                })
                .from(rikaHostedThreadProtocolEvents)
                .where(
                  and(
                    eq(rikaHostedThreadProtocolEvents.ownerId, input.ownerId),
                    eq(rikaHostedThreadProtocolEvents.threadId, input.threadId),
                    gt(rikaHostedThreadProtocolEvents.cursor, bigintValue(cursor)),
                    lte(rikaHostedThreadProtocolEvents.cursor, bigintValue(targetCursor)),
                  ),
                )
                .orderBy(asc(rikaHostedThreadProtocolEvents.sequence))
                .limit(limit + 1),
            )
          let replayCursor = input.afterCursor
          let eventRows = yield* readEvents(replayCursor)
          const directTail = isDirectReplayTail(replayCursor, targetCursor, eventRows[0]?.cursor)
          const retainedTail = isRetainedReplayTail(input, directTail)
          const requiredCheckpoint = replayCheckpointCondition(input, targetCursor, retainedTail)
          const snapshotRows = skipReplaySnapshot(input, retainedTail, requiredCheckpoint !== undefined)
            ? []
            : yield* query(
                tx
                  .select({
                    threadVersion: bigintText(rikaHostedThreadProtocolSnapshots.threadVersion),
                    cursor: bigintText(rikaHostedThreadProtocolSnapshots.cursor),
                    snapshot: rikaHostedThreadProtocolSnapshots.snapshot,
                    createdAt: timestampText(rikaHostedThreadProtocolSnapshots.createdAt),
                  })
                  .from(rikaHostedThreadProtocolSnapshots)
                  .where(
                    and(
                      eq(rikaHostedThreadProtocolSnapshots.ownerId, input.ownerId),
                      eq(rikaHostedThreadProtocolSnapshots.threadId, input.threadId),
                      requiredCheckpoint ?? replaySnapshotCondition(replayCursor, targetCursor),
                      lte(rikaHostedThreadProtocolSnapshots.threadVersion, bigintValue(state.version)),
                    ),
                  )
                  .orderBy(desc(rikaHostedThreadProtocolSnapshots.cursor))
                  .limit(1),
              )
          const snapshotRow = snapshotRows[0]
          if (snapshotRow !== undefined) {
            replayCursor = ThreadEventCursor.make(snapshotRow.cursor)
            eventRows = yield* readEvents(replayCursor)
          }
          const hasMore = eventRows.length > limit
          eventRows = eventRows.slice(0, limit)
          const events: Array<ThreadProtocolEvent> = []
          for (const row of eventRows)
            events.push({
              ownerId: input.ownerId,
              threadId: input.threadId,
              sequence: row.sequence,
              cursor: ThreadEventCursor.make(row.cursor),
              threadVersion: ThreadVersion.make(row.threadVersion),
              event: yield* decode(InteractiveEventSchema)(row.event),
              createdAt: Timestamp.make(row.createdAt),
            })
          const replayResult: Effect.Success<ReturnType<ThreadProtocolStoreService["replay"]>> = {
            threadVersion: ThreadVersion.make(state.version),
            cursor: ThreadEventCursor.make(state.cursor),
            events,
            hasMore,
          }
          if (snapshotRow !== undefined)
            Object.assign(replayResult, {
              snapshot: {
                ownerId: input.ownerId,
                threadId: input.threadId,
                threadVersion: ThreadVersion.make(snapshotRow.threadVersion),
                cursor: ThreadEventCursor.make(snapshotRow.cursor),
                snapshot: yield* decode(HostedThreadSnapshot)(snapshotRow.snapshot),
                createdAt: Timestamp.make(snapshotRow.createdAt),
              },
            })
          return replayResult
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  return { appendEvents, checkpoint, saveSnapshot, replay, writeEvents, stateForUpdate, writeSnapshot, checkpointDue }
}
