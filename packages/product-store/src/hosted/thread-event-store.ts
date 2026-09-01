import * as PgClient from "@effect/sql-pg/PgClient"
import {
  HostedThreadEventStore,
  type AppendEventInput,
  type AppendRecoveredEventInput,
  type HostedThreadEventStoreService,
} from "@rika/product/hosted-thread-event-store"
import {
  CommitCursor,
  ExecutorInstanceId,
  JsonObject,
  OwnerId,
  Sequence,
  ThreadEvent,
  ThreadId,
} from "@rika/product/hosted-model"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { and, eq, gt, inArray, or, sql, type SQLWrapper } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Layer, Schema } from "effect"
import type { Row as SqlRow } from "effect/unstable/sql/SqlConnection"
import {
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperations,
  rikaHostedOwnerCounters,
  rikaHostedThreadEvents,
  rikaHostedThreads,
} from "../database/schema/product"

const timestampText = (column: SQLWrapper) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
type DatabaseExecutor = Pick<PgDrizzle.EffectPgDatabase, "update">
const databaseError = (cause: unknown) =>
  HostedPersistenceError.make({ reason: "database", message: `PostgreSQL operation failed: ${String(cause)}` })
const failure = (reason: HostedPersistenceError["reason"], message: string) =>
  HostedPersistenceError.make({ reason, message })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const decode = <S extends Schema.Top>(schema: S, value: SqlRow | undefined) =>
  Schema.decodeEffect(schema)(value).pipe(Effect.mapError(databaseError))
const eventFields = {
  ownerId: rikaHostedThreadEvents.ownerId,
  threadId: rikaHostedThreadEvents.threadId,
  eventId: rikaHostedThreadEvents.eventId,
  idempotencyKey: rikaHostedThreadEvents.idempotencyKey,
  assignmentId: rikaHostedThreadEvents.assignmentId,
  executorInstanceId: rikaHostedThreadEvents.executorInstanceId,
  assignmentGeneration: sql<string>`${rikaHostedThreadEvents.assignmentGeneration}::text`,
  leaseEpoch: sql<string>`${rikaHostedThreadEvents.leaseEpoch}::text`,
  sequence: sql<string>`${rikaHostedThreadEvents.sequence}::text`,
  commitCursor: sql<string>`${rikaHostedThreadEvents.commitCursor}::text`,
  commandSequence: sql<string | null>`${rikaHostedThreadEvents.commandSequence}::text`,
  event: rikaHostedThreadEvents.event,
  createdAt: timestampText(rikaHostedThreadEvents.createdAt),
}
const eventEquivalent = Schema.toEquivalence(
  Schema.Struct({
    ownerId: ThreadEvent.fields.ownerId,
    threadId: ThreadEvent.fields.threadId,
    eventId: ThreadEvent.fields.eventId,
    idempotencyKey: ThreadEvent.fields.idempotencyKey,
    assignmentId: ThreadEvent.fields.assignmentId,
    executorInstanceId: ThreadEvent.fields.executorInstanceId,
    assignmentGeneration: ThreadEvent.fields.assignmentGeneration,
    leaseEpoch: ThreadEvent.fields.leaseEpoch,
    commandSequence: ThreadEvent.fields.commandSequence,
    event: JsonObject,
  }),
)

const allocateCommitCursor = Effect.fn("HostedThreadEventStore.allocateCommitCursor")(function* (
  db: DatabaseExecutor,
  ownerId: string,
) {
  const rows = yield* query(
    db
      .update(rikaHostedOwnerCounters)
      .set({ nextCommitCursor: sql`${rikaHostedOwnerCounters.nextCommitCursor} + 1` })
      .where(eq(rikaHostedOwnerCounters.ownerId, ownerId))
      .returning({ cursor: sql<string>`(${rikaHostedOwnerCounters.nextCommitCursor} - 1)::text` }),
  )
  if (rows[0] === undefined) return yield* failure("invalid-authority", "Owner authority is not initialized")
  return CommitCursor.make(rows[0].cursor)
})

const make = Effect.gen(function* (): Effect.fn.Return<HostedThreadEventStoreService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const appendEvent = Effect.fn("HostedThreadEventStore.appendEvent")(function* (input: AppendEventInput) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const assignments = yield* query(
            tx
              .select({
                ownerId: rikaHostedExecutorAssignments.ownerId,
                threadId: rikaHostedExecutorAssignments.threadId,
                executorInstanceId: rikaHostedExecutorAssignments.executorInstanceId,
              })
              .from(rikaHostedExecutorAssignments)
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, input.assignmentId),
                  eq(rikaHostedExecutorAssignments.generation, sql<number>`${input.assignmentGeneration}::bigint`),
                  eq(rikaHostedExecutorAssignments.leaseEpoch, sql<number>`${input.leaseEpoch}::bigint`),
                  eq(rikaHostedExecutorAssignments.lifecycle, "active"),
                  gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql<Date>`transaction_timestamp()`),
                ),
              )
              .for("share"),
          )
          const assignment = assignments[0]
          if (assignment === undefined || assignment.executorInstanceId === null)
            return yield* failure("stale-fence", "Executor assignment is expired or fenced")
          const locked = yield* query(
            tx
              .select({ id: rikaHostedThreads.id })
              .from(rikaHostedThreads)
              .where(
                and(eq(rikaHostedThreads.id, assignment.threadId), eq(rikaHostedThreads.ownerId, assignment.ownerId)),
              )
              .for("update"),
          )
          if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist in the organization")
          const existingRows = yield* query(
            tx
              .select(eventFields)
              .from(rikaHostedThreadEvents)
              .where(
                and(
                  eq(rikaHostedThreadEvents.threadId, assignment.threadId),
                  or(
                    eq(rikaHostedThreadEvents.eventId, input.eventId),
                    eq(rikaHostedThreadEvents.idempotencyKey, input.idempotencyKey),
                  ),
                ),
              ),
          )
          if (existingRows.length > 1)
            return yield* failure("conflict", "Event identity or idempotency key collides with multiple events")
          const comparable = {
            ...input,
            ownerId: OwnerId.make(assignment.ownerId),
            threadId: ThreadId.make(assignment.threadId),
            executorInstanceId: ExecutorInstanceId.make(assignment.executorInstanceId),
          }
          if (existingRows[0] !== undefined) {
            const existing = yield* decode(ThreadEvent, existingRows[0])
            if (!eventEquivalent(existing, comparable))
              return yield* failure("conflict", "Event identity or idempotency key was reused with different content")
            return existing
          }
          const sequences = yield* query(
            tx
              .update(rikaHostedThreads)
              .set({ nextEventSequence: sql`${rikaHostedThreads.nextEventSequence} + 1` })
              .where(
                and(eq(rikaHostedThreads.id, assignment.threadId), eq(rikaHostedThreads.ownerId, assignment.ownerId)),
              )
              .returning({ sequence: sql<string>`(${rikaHostedThreads.nextEventSequence} - 1)::text` }),
          )
          const sequence = Sequence.make(sequences[0]!.sequence)
          const commitCursor = yield* allocateCommitCursor(tx, assignment.ownerId)
          const rows = yield* query(
            tx
              .insert(rikaHostedThreadEvents)
              .values({
                ownerId: assignment.ownerId,
                threadId: assignment.threadId,
                eventId: input.eventId,
                idempotencyKey: input.idempotencyKey,
                assignmentId: input.assignmentId,
                executorInstanceId: assignment.executorInstanceId,
                assignmentGeneration: sql<number>`${input.assignmentGeneration}::bigint`,
                leaseEpoch: sql<number>`${input.leaseEpoch}::bigint`,
                sequence: sql<number>`${sequence}::bigint`,
                commitCursor: sql<number>`${commitCursor}::bigint`,
                commandSequence: input.commandSequence === null ? null : sql<number>`${input.commandSequence}::bigint`,
                event: input.event,
              })
              .returning(eventFields),
          )
          return yield* decode(ThreadEvent, rows[0])
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const appendRecoveredEvent = Effect.fn("HostedThreadEventStore.appendRecoveredEvent")(function* (
    input: AppendRecoveredEventInput,
  ) {
    if (String(input.eventId) !== String(input.idempotencyKey))
      return yield* failure("conflict", "Recovered event identity must equal its operation key")
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const assignments = yield* query(
            tx
              .select({
                ownerId: rikaHostedExecutorAssignments.ownerId,
                threadId: rikaHostedExecutorAssignments.threadId,
              })
              .from(rikaHostedExecutorAssignments)
              .where(eq(rikaHostedExecutorAssignments.id, input.assignmentId))
              .for("share"),
          )
          const assignment = assignments[0]
          if (assignment === undefined) return yield* failure("not-found", "Executor assignment does not exist")
          const operations = yield* query(
            tx
              .select({ operationKey: rikaHostedExecutorOperations.operationKey })
              .from(rikaHostedExecutorOperations)
              .where(
                and(
                  eq(rikaHostedExecutorOperations.assignmentId, input.assignmentId),
                  eq(rikaHostedExecutorOperations.operationKey, input.idempotencyKey),
                  inArray(rikaHostedExecutorOperations.state, ["completed", "unknown"]),
                  eq(
                    rikaHostedExecutorOperations.dispatchedGeneration,
                    sql<number>`${input.assignmentGeneration}::bigint`,
                  ),
                  eq(rikaHostedExecutorOperations.dispatchedLeaseEpoch, sql<number>`${input.leaseEpoch}::bigint`),
                  eq(rikaHostedExecutorOperations.dispatchedExecutorInstanceId, input.executorInstanceId),
                  eq(rikaHostedExecutorOperations.dispatchedProcessIncarnation, input.processIncarnation),
                ),
              )
              .for("update"),
          )
          if (operations[0] === undefined)
            return yield* failure("stale-fence", "Recovered event does not match the dispatched operation fence")
          const locked = yield* query(
            tx
              .select({ id: rikaHostedThreads.id })
              .from(rikaHostedThreads)
              .where(
                and(eq(rikaHostedThreads.id, assignment.threadId), eq(rikaHostedThreads.ownerId, assignment.ownerId)),
              )
              .for("update"),
          )
          if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist in the organization")
          const existingRows = yield* query(
            tx
              .select(eventFields)
              .from(rikaHostedThreadEvents)
              .where(
                and(
                  eq(rikaHostedThreadEvents.threadId, assignment.threadId),
                  or(
                    eq(rikaHostedThreadEvents.eventId, input.eventId),
                    eq(rikaHostedThreadEvents.idempotencyKey, input.idempotencyKey),
                  ),
                ),
              ),
          )
          if (existingRows.length > 1)
            return yield* failure("conflict", "Recovered event identity collides with multiple events")
          const comparable = {
            ...input,
            ownerId: OwnerId.make(assignment.ownerId),
            threadId: ThreadId.make(assignment.threadId),
            executorInstanceId: ExecutorInstanceId.make(input.executorInstanceId),
          }
          const existingRow = existingRows[0]
          if (existingRow !== undefined) {
            const existing = yield* decode(ThreadEvent, existingRow)
            if (!eventEquivalent(existing, comparable))
              return yield* failure("conflict", "Event identity or idempotency key was reused with different content")
            return existing
          }
          const sequences = yield* query(
            tx
              .update(rikaHostedThreads)
              .set({ nextEventSequence: sql`${rikaHostedThreads.nextEventSequence} + 1` })
              .where(
                and(eq(rikaHostedThreads.id, assignment.threadId), eq(rikaHostedThreads.ownerId, assignment.ownerId)),
              )
              .returning({ sequence: sql<string>`(${rikaHostedThreads.nextEventSequence} - 1)::text` }),
          )
          const sequence = Sequence.make(sequences[0]!.sequence)
          const commitCursor = yield* allocateCommitCursor(tx, assignment.ownerId)
          const rows = yield* query(
            tx
              .insert(rikaHostedThreadEvents)
              .values({
                ownerId: assignment.ownerId,
                threadId: assignment.threadId,
                eventId: input.eventId,
                idempotencyKey: input.idempotencyKey,
                assignmentId: input.assignmentId,
                executorInstanceId: input.executorInstanceId,
                assignmentGeneration: sql<number>`${input.assignmentGeneration}::bigint`,
                leaseEpoch: sql<number>`${input.leaseEpoch}::bigint`,
                sequence: sql<number>`${sequence}::bigint`,
                commitCursor: sql<number>`${commitCursor}::bigint`,
                commandSequence: input.commandSequence === null ? null : sql<number>`${input.commandSequence}::bigint`,
                event: input.event,
              })
              .returning(eventFields),
          )
          return yield* decode(ThreadEvent, rows[0])
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  return HostedThreadEventStore.of({ appendEvent, appendRecoveredEvent })
})

export const layer = Layer.effect(HostedThreadEventStore, make)
