import * as PgClient from "@effect/sql-pg/PgClient"
import { and, asc, desc, eq, gt, gte, isNull, lt, lte, max, min, notExists, or, sql, type SQLWrapper } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { alias } from "drizzle-orm/pg-core"
import { Effect, Layer, Schema } from "effect"
import {
  ActorAttribution,
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  IdempotencyKey,
  JsonObject,
  OwnerId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "@rika/product/hosted-model"
import { StoreError } from "@rika/product/hosted-store"
import { InteractiveEventSchema } from "@rika/product/interactive-event"
import { HostedThreadSnapshot } from "@rika/product/client-protocol"
import {
  ThreadProtocolStore,
  type ThreadProtocolCommand,
  type ThreadProtocolEvent,
  type ThreadProtocolStoreService,
} from "@rika/product/thread-protocol-store"
import {
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolCursors,
  rikaHostedThreadProtocolEvents,
  rikaHostedThreadProtocolSnapshots,
  rikaHostedThreadProtocolState,
  rikaHostedThreads,
  rikaHostedThreadSocketTickets,
} from "../database/schema/product"
import { requireThreadAccess } from "./authority"

const databaseError = (cause: unknown) =>
  StoreError.make({ reason: "database", message: `Thread protocol PostgreSQL operation failed: ${String(cause)}` })
const failure = (reason: StoreError["reason"], message: string) => StoreError.make({ reason, message })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const decode = <S extends Schema.Top>(schema: S) =>
  <Value>(value: Value) => Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(databaseError))
const jsonEquivalent = Schema.toEquivalence(JsonObject)
const actorEquivalent = Schema.toEquivalence(ActorAttribution)
const bigintText = (column: SQLWrapper) => sql<string>`${column}::text`
const bigintValue = (value: string) => sql<number>`${value}::bigint`
const timestampValue = (value: string) => sql<Date>`${value}::timestamptz`
const timestampText = (column: SQLWrapper) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const commandFields = {
  ownerId: rikaHostedThreadProtocolCommands.ownerId,
  threadId: rikaHostedThreadProtocolCommands.threadId,
  commandId: rikaHostedThreadProtocolCommands.commandId,
  idempotencyKey: rikaHostedThreadProtocolCommands.idempotencyKey,
  expectedThreadVersion: bigintText(rikaHostedThreadProtocolCommands.expectedVersion),
  threadVersion: bigintText(rikaHostedThreadProtocolCommands.threadVersion),
  actor: rikaHostedThreadProtocolCommands.actor,
  command: rikaHostedThreadProtocolCommands.command,
  state: rikaHostedThreadProtocolCommands.state,
  result: rikaHostedThreadProtocolCommands.result,
  cursor: bigintText(rikaHostedThreadProtocolCommands.eventCursor),
  admittedAt: timestampText(rikaHostedThreadProtocolCommands.admittedAt),
  completedAt: timestampText(rikaHostedThreadProtocolCommands.completedAt),
}

interface CommandRow {
  readonly ownerId: string
  readonly threadId: string
  readonly commandId: string
  readonly idempotencyKey: string
  readonly expectedThreadVersion: string
  readonly threadVersion: string
  readonly actor: unknown
  readonly command: unknown
  readonly state: string
  readonly result: unknown | null
  readonly cursor: string | null
  readonly admittedAt: string
  readonly completedAt: string | null
}

const commandRow = Effect.fn("ThreadProtocolStore.commandRow")(function* (row: CommandRow) {
  const command: ThreadProtocolCommand = {
    ownerId: OwnerId.make(row.ownerId),
    threadId: ThreadId.make(row.threadId),
    commandId: CommandId.make(row.commandId),
    idempotencyKey: IdempotencyKey.make(row.idempotencyKey),
    expectedThreadVersion: ThreadVersion.make(row.expectedThreadVersion),
    threadVersion: ThreadVersion.make(row.threadVersion),
    actor: yield* decode(ActorAttribution)(row.actor),
    command: yield* decode(JsonObject)(row.command),
    state: yield* decode(Schema.Literals(["admitted", "completed"]))(row.state),
    admittedAt: Timestamp.make(row.admittedAt),
  }
  if (row.result !== null) Object.assign(command, { result: yield* decode(JsonObject)(row.result) })
  if (row.cursor !== null) Object.assign(command, { cursor: ThreadEventCursor.make(row.cursor) })
  if (row.completedAt !== null) Object.assign(command, { completedAt: Timestamp.make(row.completedAt) })
  return command
})

const make = Effect.gen(function* (): Effect.fn.Return<ThreadProtocolStoreService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const initializeThread: ThreadProtocolStoreService["initializeThread"] = Effect.fn(
    "ThreadProtocolStore.initializeThread",
  )(function* (input) {
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "thread:view")
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

  const admitCommand: ThreadProtocolStoreService["admitCommand"] = Effect.fn(
    "ThreadProtocolStore.admitCommand",
  )(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "thread:control", input.admittedAt)
          const states = yield* query(
            tx
              .select({ version: bigintText(rikaHostedThreadProtocolState.version) })
              .from(rikaHostedThreadProtocolState)
              .where(
                and(
                  eq(rikaHostedThreadProtocolState.ownerId, input.ownerId),
                  eq(rikaHostedThreadProtocolState.threadId, input.threadId),
                ),
              )
              .for("update"),
          )
          const state = states[0]
          if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
          const existingRows = yield* query(
            tx
              .select(commandFields)
              .from(rikaHostedThreadProtocolCommands)
              .where(
                and(
                  eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
                  or(
                    eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
                    eq(rikaHostedThreadProtocolCommands.idempotencyKey, input.idempotencyKey),
                  ),
                ),
              )
              .for("update"),
          )
          if (existingRows.length > 0) {
            if (existingRows.length !== 1)
              return yield* failure("conflict", "Command identities refer to different commands")
            const existing = yield* commandRow(existingRows[0]!)
            if (
              existing.commandId !== input.commandId ||
              existing.idempotencyKey !== input.idempotencyKey ||
              existing.expectedThreadVersion !== input.expectedThreadVersion ||
              !actorEquivalent(existing.actor, input.actor) ||
              !jsonEquivalent(existing.command, input.command)
            )
              return yield* failure("conflict", "Command identity was reused with incompatible input")
            return { _tag: "Duplicate" as const, command: existing }
          }
          if (state.version !== input.expectedThreadVersion)
            return yield* failure(
              "stale-version",
              `Expected Thread version ${input.expectedThreadVersion}; current is ${state.version}`,
            )
          const nextVersion = (BigInt(state.version) + 1n).toString()
          const inserted = yield* query(
            tx
              .insert(rikaHostedThreadProtocolCommands)
              .values({
                ownerId: input.ownerId,
                threadId: input.threadId,
                commandId: input.commandId,
                idempotencyKey: input.idempotencyKey,
                expectedVersion: bigintValue(input.expectedThreadVersion),
                threadVersion: bigintValue(nextVersion),
                actor: input.actor,
                command: input.command,
                state: "admitted",
                admittedAt: timestampValue(input.admittedAt),
              })
              .returning(commandFields),
          )
          yield* query(
            tx
              .update(rikaHostedThreadProtocolState)
              .set({ version: bigintValue(nextVersion) })
              .where(
                and(
                  eq(rikaHostedThreadProtocolState.ownerId, input.ownerId),
                  eq(rikaHostedThreadProtocolState.threadId, input.threadId),
                ),
              )
              .returning({ threadId: rikaHostedThreadProtocolState.threadId }),
          )
          return { _tag: "Admitted" as const, command: yield* commandRow(inserted[0]!) }
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

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
    const written: Array<ThreadProtocolEvent> = []
    for (let index = 0; index < input.events.length; index += 1) {
      const sequence = (input.firstCursor + BigInt(index)).toString()
      const event = input.events[index]!
      yield* query(
        tx.insert(rikaHostedThreadProtocolEvents).values({
          ownerId: input.ownerId,
          threadId: input.threadId,
          sequence: bigintValue(sequence),
          cursor: bigintValue(sequence),
          threadVersion: bigintValue(input.threadVersion),
          event,
          createdAt: timestampValue(input.createdAt),
        }),
      )
      written.push({
        ownerId: input.ownerId,
        threadId: input.threadId,
        sequence,
        cursor: ThreadEventCursor.make(sequence),
        threadVersion: input.threadVersion,
        event,
        createdAt: input.createdAt,
      })
    }
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

  const claimNextCommand: ThreadProtocolStoreService["claimNextCommand"] = Effect.fn(
    "ThreadProtocolStore.claimNextCommand",
  )(function* (input) {
    return yield* db.transaction((tx) => Effect.gen(function* () {
      const predecessor = alias(rikaHostedThreadProtocolCommands, "predecessor")
      const rows = yield* query(tx.select(commandFields).from(rikaHostedThreadProtocolCommands).where(and(
        eq(rikaHostedThreadProtocolCommands.state, "admitted"),
        or(isNull(rikaHostedThreadProtocolCommands.claimToken), lte(rikaHostedThreadProtocolCommands.claimExpiresAt, sql`transaction_timestamp()`)),
        notExists(tx.select({ commandId: predecessor.commandId }).from(predecessor).where(and(
          eq(predecessor.threadId, rikaHostedThreadProtocolCommands.threadId),
          lt(predecessor.threadVersion, rikaHostedThreadProtocolCommands.threadVersion),
          eq(predecessor.state, "admitted"),
          sql`not (${rikaHostedThreadProtocolCommands.command} ->> '_tag' = 'Cancel'
            and ${rikaHostedThreadProtocolCommands.command} -> 'target' ->> '_tag' = 'Command'
            and ${predecessor.commandId} = ${rikaHostedThreadProtocolCommands.command} -> 'target' ->> 'commandId'
            and ${predecessor.command} ->> '_tag' = 'SubmitPrompt')`,
        ))),
      )).orderBy(asc(rikaHostedThreadProtocolCommands.admittedAt), asc(rikaHostedThreadProtocolCommands.threadId),
        asc(rikaHostedThreadProtocolCommands.threadVersion)).limit(1).for("update", { skipLocked: true }))
      const row = rows[0]
      if (row === undefined) return undefined
      const claimed = yield* query(tx.update(rikaHostedThreadProtocolCommands).set({
        claimToken: input.claimToken,
        claimExpiresAt: sql`transaction_timestamp() + ${input.claimMillis} * interval '1 millisecond'`,
      }).where(and(eq(rikaHostedThreadProtocolCommands.threadId, row.threadId),
        eq(rikaHostedThreadProtocolCommands.commandId, row.commandId))).returning(commandFields))
      return yield* commandRow(claimed[0]!)
    })).pipe(Effect.catchTag("SqlError", databaseError))
  })

  const renewCommandClaim: ThreadProtocolStoreService["renewCommandClaim"] = Effect.fn(
    "ThreadProtocolStore.renewCommandClaim",
  )(function* (input) {
    const rows = yield* query(db.update(rikaHostedThreadProtocolCommands).set({
      claimExpiresAt: sql`transaction_timestamp() + ${input.claimMillis} * interval '1 millisecond'`,
    }).where(and(eq(rikaHostedThreadProtocolCommands.ownerId, input.ownerId),
      eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
      eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
      eq(rikaHostedThreadProtocolCommands.state, "admitted"),
      eq(rikaHostedThreadProtocolCommands.claimToken, input.claimToken),
      gt(rikaHostedThreadProtocolCommands.claimExpiresAt, sql`transaction_timestamp()`),
    )).returning({ commandId: rikaHostedThreadProtocolCommands.commandId }))
    return rows[0] !== undefined
  })

  const releaseCommandClaim: ThreadProtocolStoreService["releaseCommandClaim"] = Effect.fn(
    "ThreadProtocolStore.releaseCommandClaim",
  )(function* (input) {
    yield* query(db.update(rikaHostedThreadProtocolCommands).set({ claimToken: null, claimExpiresAt: null }).where(and(
      eq(rikaHostedThreadProtocolCommands.ownerId, input.ownerId),
      eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
      eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
      eq(rikaHostedThreadProtocolCommands.state, "admitted"),
      eq(rikaHostedThreadProtocolCommands.claimToken, input.claimToken),
    ))).pipe(Effect.asVoid)
  })

  const completeCommand: ThreadProtocolStoreService["completeCommand"] = Effect.fn(
    "ThreadProtocolStore.completeCommand",
  )(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const state = (yield* stateForUpdate(tx, input.ownerId, input.threadId))[0]
          if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
          const current = (
            yield* query(
              tx
                .select({
                  ...commandFields,
                  claimToken: rikaHostedThreadProtocolCommands.claimToken,
                  claimActive: sql<boolean>`${rikaHostedThreadProtocolCommands.claimExpiresAt} > transaction_timestamp()`,
                })
                .from(rikaHostedThreadProtocolCommands)
                .where(
                  and(
                    eq(rikaHostedThreadProtocolCommands.ownerId, input.ownerId),
                    eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
                    eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
                  ),
                )
                .for("update"),
            )
          )[0]
          if (current === undefined) return yield* failure("not-found", "Command is unavailable")
          const currentCommand = yield* commandRow(current)
          if (current.state === "completed") return { _tag: "Duplicate" as const, command: currentCommand }
          if (current.claimToken !== input.claimToken || current.claimActive !== true)
            return yield* failure("stale-fence", "Command application claim is expired or fenced")
          const threadVersion = ThreadVersion.make(current.threadVersion)
          const events = yield* writeEvents(tx, {
            ownerId: input.ownerId,
            threadId: input.threadId,
            threadVersion,
            firstCursor: BigInt(state.cursor) + 1n,
            events: input.events,
            createdAt: input.completedAt,
          })
          const cursor = events.at(-1)?.cursor ?? ThreadEventCursor.make(state.cursor)
          if (input.events.length > 0)
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
          if (input.snapshot !== undefined)
            yield* query(
              tx.insert(rikaHostedThreadProtocolSnapshots).values({
                ownerId: input.ownerId,
                threadId: input.threadId,
                threadVersion: bigintValue(threadVersion),
                cursor: bigintValue(cursor),
                snapshot: input.snapshot,
                createdAt: timestampValue(input.completedAt),
              }),
            )
          const completed = yield* query(
            tx
              .update(rikaHostedThreadProtocolCommands)
              .set({
                state: "completed",
                result: input.result,
                eventCursor: bigintValue(cursor),
                completedAt: timestampValue(input.completedAt),
                claimToken: null,
                claimExpiresAt: null,
              })
              .where(
                and(
                  eq(rikaHostedThreadProtocolCommands.ownerId, input.ownerId),
                  eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
                  eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
                ),
              )
              .returning(commandFields),
          )
          return { _tag: "Completed" as const, command: yield* commandRow(completed[0]!) }
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const appendEvents: ThreadProtocolStoreService["appendEvents"] = Effect.fn(
    "ThreadProtocolStore.appendEvents",
  )(function* (input) {
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
          yield* query(
            tx
              .insert(rikaHostedThreadProtocolSnapshots)
              .values({
                ownerId: input.ownerId,
                threadId: input.threadId,
                threadVersion: bigintValue(state.version),
                cursor: bigintValue(cursor),
                snapshot: input.snapshot,
                createdAt: timestampValue(input.createdAt),
              })
              .onConflictDoUpdate({
                target: [
                  rikaHostedThreadProtocolSnapshots.threadId,
                  rikaHostedThreadProtocolSnapshots.threadVersion,
                ],
                set: {
                  cursor: bigintValue(cursor),
                  snapshot: input.snapshot,
                  createdAt: timestampValue(input.createdAt),
                },
              }),
          )
          return events
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const saveSnapshot: ThreadProtocolStoreService["saveSnapshot"] = Effect.fn(
    "ThreadProtocolStore.saveSnapshot",
  )(function* (input) {
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
          yield* query(
            tx
              .insert(rikaHostedThreadProtocolSnapshots)
              .values({
                ownerId: input.ownerId,
                threadId: input.threadId,
                threadVersion: bigintValue(input.threadVersion),
                cursor: bigintValue(input.cursor),
                snapshot: input.snapshot,
                createdAt: timestampValue(input.createdAt),
              })
              .onConflictDoUpdate({
                target: [
                  rikaHostedThreadProtocolSnapshots.threadId,
                  rikaHostedThreadProtocolSnapshots.threadVersion,
                ],
                set: {
                  cursor: bigintValue(input.cursor),
                  snapshot: input.snapshot,
                  createdAt: timestampValue(input.createdAt),
                },
              }),
          )
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const replay: ThreadProtocolStoreService["replay"] = Effect.fn("ThreadProtocolStore.replay")(
    function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* requireThreadAccess(tx, input, "thread:view")
            const state = (
              yield* query(
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
              )
            )[0]
            if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
            const stateCursor = BigInt(state.cursor)
            const throughCursor = input.throughCursor === undefined ? stateCursor : BigInt(input.throughCursor)
            const targetCursor = ThreadEventCursor.make(
              (throughCursor < stateCursor ? throughCursor : stateCursor).toString(),
            )
            const snapshotRows =
              input.includeSnapshot === false
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
                          lte(rikaHostedThreadProtocolSnapshots.cursor, bigintValue(targetCursor)),
                          lte(rikaHostedThreadProtocolSnapshots.threadVersion, bigintValue(state.version)),
                        ),
                      )
                      .orderBy(
                        desc(rikaHostedThreadProtocolSnapshots.threadVersion),
                        desc(rikaHostedThreadProtocolSnapshots.cursor),
                      )
                      .limit(1),
                  )
            const snapshotRow = snapshotRows[0]
            const replayCursor = snapshotRow?.cursor ?? input.afterCursor
            const eventRows = yield* query(
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
                    gt(rikaHostedThreadProtocolEvents.cursor, bigintValue(replayCursor)),
                    lte(rikaHostedThreadProtocolEvents.cursor, bigintValue(targetCursor)),
                  ),
                )
                .orderBy(asc(rikaHostedThreadProtocolEvents.sequence))
                .limit(Math.min(Math.max(Math.trunc(input.limit), 1), 1_000)),
            )
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
    },
  )

  const acknowledgeCursor: ThreadProtocolStoreService["acknowledgeCursor"] = Effect.fn(
    "ThreadProtocolStore.acknowledgeCursor",
  )(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "thread:view", input.acknowledgedAt)
          const states = yield* query(
            tx
              .select({ ownerId: rikaHostedThreadProtocolState.ownerId, threadId: rikaHostedThreadProtocolState.threadId })
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
          return ThreadEventCursor.make(rows[0]!.cursor)
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const issueTicket: ThreadProtocolStoreService["issueTicket"] = Effect.fn("ThreadProtocolStore.issueTicket")(
    (input) =>
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

  const redeemTicket: ThreadProtocolStoreService["redeemTicket"] = Effect.fn(
    "ThreadProtocolStore.redeemTicket",
  )(function* (input) {
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
                eq(rikaHostedDevices.id, rikaHostedThreadSocketTickets.deviceId),
                eq(rikaHostedDevices.userId, rikaHostedThreadSocketTickets.userId),
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
  })

  const revokeTicket: ThreadProtocolStoreService["revokeTicket"] = Effect.fn(
    "ThreadProtocolStore.revokeTicket",
  )((ticketId) =>
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

  return ThreadProtocolStore.of({
    initializeThread,
    admitCommand,
    claimNextCommand,
    renewCommandClaim,
    releaseCommandClaim,
    completeCommand,
    appendEvents,
    saveSnapshot,
    replay,
    acknowledgeCursor,
    issueTicket,
    redeemTicket,
    revokeTicket,
  })
})

export const layer = Layer.effect(ThreadProtocolStore, make)
