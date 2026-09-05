import { ThreadEventCursor, ThreadVersion } from "@rika/product/hosted-model"
import type { ThreadProtocolStoreService } from "@rika/product/thread-protocol-store"
import { and, asc, eq, gt, isNull, lt, lte, notExists, or, sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { alias } from "drizzle-orm/pg-core"
import { Effect } from "effect"
import {
  rikaHostedOwnerCounters,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolState,
} from "../../database/schema/product"
import { requireThreadAccess } from "../authority"
import { commandApplicationOperations } from "./command-application"
import type { eventOperations } from "./events"
import {
  bigintText,
  bigintValue,
  commandFields,
  commandRow,
  databaseError,
  persistenceErrors,
  protocolEquivalence,
  query,
  timestampValue,
} from "./persistence"

type EventOperations = ReturnType<typeof eventOperations>

export const commandOperations = ({
  db,
  events: eventStore,
}: {
  db: PgDrizzle.EffectPgDatabase
  events: EventOperations
}) => {
  const { failure } = persistenceErrors
  const { actor: actorEquivalent, json: jsonEquivalent } = protocolEquivalence
  const { checkpointDue, stateForUpdate, writeEvents, writeSnapshot } = eventStore
  const admit = Effect.fn("ThreadProtocolStore.admit")(function* (
    input:
      | Parameters<ThreadProtocolStoreService["admitCommand"]>[0]
      | Parameters<ThreadProtocolStoreService["admitServerCommand"]>[0],
    expectedVersion: ThreadVersion | undefined,
  ) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* requireThreadAccess(tx, input, "thread:control", input.admittedAt)
          const readExisting = Effect.gen(function* () {
            const rows = yield* query(
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
                ),
            )
            if (rows.length === 0) return undefined
            if (rows.length !== 1) return yield* failure("conflict", "Command identities refer to different commands")
            const existing = yield* commandRow(rows[0]!)
            if (
              existing.commandId !== input.commandId ||
              existing.idempotencyKey !== input.idempotencyKey ||
              (expectedVersion !== undefined && existing.expectedThreadVersion !== expectedVersion) ||
              !actorEquivalent(existing.actor, input.actor) ||
              !jsonEquivalent(existing.command, input.command)
            )
              return yield* failure("conflict", "Command identity was reused with incompatible input")
            return { _tag: "Duplicate" as const, command: existing }
          })
          // Receipt reads must not lock the lane that the command worker claims with SKIP LOCKED.
          // Releasing a read-only transaction emits no notification to wake a skipped worker.
          const existing = yield* readExisting
          if (existing !== undefined) return existing
          const state = (yield* query(
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
          ))[0]
          if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
          // Another admission may have committed while this transaction waited for the lane.
          const concurrent = yield* readExisting
          if (concurrent !== undefined) return concurrent
          const currentVersion = ThreadVersion.make(state.version)
          if (expectedVersion !== undefined && currentVersion !== expectedVersion)
            return yield* failure(
              "stale-version",
              `Expected Thread version ${expectedVersion}; current is ${currentVersion}`,
            )
          const nextVersion = (BigInt(currentVersion) + 1n).toString()
          const cursors = yield* query(
            tx
              .update(rikaHostedOwnerCounters)
              .set({ nextCommitCursor: sql`${rikaHostedOwnerCounters.nextCommitCursor} + 1` })
              .where(eq(rikaHostedOwnerCounters.ownerId, input.ownerId))
              .returning({ cursor: sql<string>`(${rikaHostedOwnerCounters.nextCommitCursor} - 1)::text` }),
          )
          if (cursors[0] === undefined) return yield* failure("invalid-authority", "Owner authority is not initialized")
          const values = {
            ownerId: input.ownerId,
            threadId: input.threadId,
            commandId: input.commandId,
            idempotencyKey: input.idempotencyKey,
            expectedVersion: bigintValue(currentVersion),
            threadVersion: bigintValue(nextVersion),
            commitCursor: bigintValue(cursors[0].cursor),
            actor: input.actor,
            command: input.command,
            state: "admitted",
            admittedAt: timestampValue(input.admittedAt),
          }
          if (input.turnId !== undefined) Object.assign(values, { turnId: input.turnId })
          const inserted = yield* query(
            tx.insert(rikaHostedThreadProtocolCommands).values(values).returning(commandFields),
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
              ),
          )
          return { _tag: "Admitted" as const, command: yield* commandRow(inserted[0]!) }
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const admitCommand: ThreadProtocolStoreService["admitCommand"] = (input) => admit(input, input.expectedThreadVersion)
  const admitServerCommand: ThreadProtocolStoreService["admitServerCommand"] = (input) => admit(input, undefined)

  const runnableCommand = (tx: PgDrizzle.EffectPgDatabase) => {
    const predecessor = alias(rikaHostedThreadProtocolCommands, "predecessor")
    return and(
      eq(rikaHostedThreadProtocolCommands.state, "admitted"),
      or(
        isNull(rikaHostedThreadProtocolCommands.claimToken),
        lte(rikaHostedThreadProtocolCommands.claimExpiresAt, sql`transaction_timestamp()`),
      ),
      notExists(
        tx
          .select({ commandId: predecessor.commandId })
          .from(predecessor)
          .where(
            and(
              eq(predecessor.threadId, rikaHostedThreadProtocolCommands.threadId),
              lt(predecessor.threadVersion, rikaHostedThreadProtocolCommands.threadVersion),
              eq(predecessor.state, "admitted"),
              sql`not (${rikaHostedThreadProtocolCommands.command} ->> '_tag' = 'Cancel'
                and ${rikaHostedThreadProtocolCommands.command} -> 'target' ->> '_tag' = 'Command'
                and ${predecessor.commandId} = ${rikaHostedThreadProtocolCommands.command} -> 'target' ->> 'commandId'
                and ${predecessor.command} ->> '_tag' = 'SubmitPrompt')`,
            ),
          ),
      ),
    )
  }

  const claimNextCommand: ThreadProtocolStoreService["claimNextCommand"] = Effect.fn(
    "ThreadProtocolStore.claimNextCommand",
  )(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const candidate = tx
            .select({
              threadId: rikaHostedThreadProtocolCommands.threadId,
              commandId: rikaHostedThreadProtocolCommands.commandId,
              admittedAt: rikaHostedThreadProtocolCommands.admittedAt,
              threadVersion: rikaHostedThreadProtocolCommands.threadVersion,
            })
            .from(rikaHostedThreadProtocolCommands)
            .where(
              and(
                eq(rikaHostedThreadProtocolCommands.threadId, rikaHostedThreadProtocolState.threadId),
                runnableCommand(tx),
              ),
            )
            .orderBy(asc(rikaHostedThreadProtocolCommands.threadVersion))
            .limit(1)
            .as("command_candidate")
          const selected = yield* query(
            tx
              .select({
                threadId: candidate.threadId,
                commandId: candidate.commandId,
              })
              .from(rikaHostedThreadProtocolState)
              .innerJoinLateral(candidate, sql`true`)
              .orderBy(asc(candidate.admittedAt), asc(candidate.threadId), asc(candidate.threadVersion))
              .limit(1)
              .for("update", { of: rikaHostedThreadProtocolState, skipLocked: true }),
          )
          const selectedCommand = selected[0]
          if (selectedCommand === undefined) return undefined
          const claimed = yield* query(
            tx
              .update(rikaHostedThreadProtocolCommands)
              .set({
                claimToken: input.claimToken,
                claimExpiresAt: sql`transaction_timestamp() + ${input.claimMillis} * interval '1 millisecond'`,
              })
              .where(
                and(
                  eq(rikaHostedThreadProtocolCommands.threadId, selectedCommand.threadId),
                  eq(rikaHostedThreadProtocolCommands.commandId, selectedCommand.commandId),
                ),
              )
              .returning(commandFields),
          )
          return yield* commandRow(claimed[0]!)
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
  })

  const oldestRunnableCommandAt: ThreadProtocolStoreService["oldestRunnableCommandAt"] = query(
    db
      .select({
        admittedAt: sql<number>`floor(extract(epoch from ${rikaHostedThreadProtocolCommands.admittedAt}) * 1000)::bigint`,
      })
      .from(rikaHostedThreadProtocolCommands)
      .where(runnableCommand(db))
      .orderBy(
        asc(rikaHostedThreadProtocolCommands.admittedAt),
        asc(rikaHostedThreadProtocolCommands.threadId),
        asc(rikaHostedThreadProtocolCommands.threadVersion),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows[0]?.admittedAt))

  const renewCommandClaim: ThreadProtocolStoreService["renewCommandClaim"] = Effect.fn(
    "ThreadProtocolStore.renewCommandClaim",
  )(function* (input) {
    const rows = yield* query(
      db
        .update(rikaHostedThreadProtocolCommands)
        .set({
          claimExpiresAt: sql`transaction_timestamp() + ${input.claimMillis} * interval '1 millisecond'`,
        })
        .where(
          and(
            eq(rikaHostedThreadProtocolCommands.ownerId, input.ownerId),
            eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
            eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
            eq(rikaHostedThreadProtocolCommands.state, "admitted"),
            eq(rikaHostedThreadProtocolCommands.claimToken, input.claimToken),
            gt(rikaHostedThreadProtocolCommands.claimExpiresAt, sql`transaction_timestamp()`),
          ),
        )
        .returning({ commandId: rikaHostedThreadProtocolCommands.commandId }),
    )
    return rows[0] !== undefined
  })

  const releaseCommandClaim: ThreadProtocolStoreService["releaseCommandClaim"] = Effect.fn(
    "ThreadProtocolStore.releaseCommandClaim",
  )(function* (input) {
    yield* query(
      db
        .update(rikaHostedThreadProtocolCommands)
        .set({ claimToken: null, claimExpiresAt: null })
        .where(
          and(
            eq(rikaHostedThreadProtocolCommands.ownerId, input.ownerId),
            eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
            eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
            eq(rikaHostedThreadProtocolCommands.state, "admitted"),
            eq(rikaHostedThreadProtocolCommands.claimToken, input.claimToken),
          ),
        ),
    ).pipe(Effect.asVoid)
  })

  const completeCommand: ThreadProtocolStoreService["completeCommand"] = Effect.fn(
    "ThreadProtocolStore.completeCommand",
  )(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const state = (yield* stateForUpdate(tx, input.ownerId, input.threadId))[0]
          if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
          const current = (yield* query(
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
          ))[0]
          if (current === undefined) return yield* failure("not-found", "Command is unavailable")
          const currentCommand = yield* commandRow(current)
          if (current.state === "completed") return { _tag: "Duplicate" as const, command: currentCommand }
          if (current.claimToken !== input.claimToken || current.claimActive !== true)
            return yield* failure("stale-fence", "Command application claim is expired or fenced")
          const threadVersion = ThreadVersion.make(state.version)
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
          const checkpointDecision =
            input.snapshot === undefined
              ? undefined
              : yield* checkpointDue(tx, input.ownerId, input.threadId, cursor, input.snapshot)
          if (input.snapshot !== undefined && checkpointDecision?.due === true)
            yield* writeSnapshot(tx, {
              ownerId: input.ownerId,
              threadId: input.threadId,
              threadVersion,
              cursor,
              snapshot: input.snapshot,
              createdAt: input.completedAt,
              replayRequired: checkpointDecision.replayRequired,
            })
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

  return {
    admitCommand,
    admitServerCommand,
    ...commandApplicationOperations({ db, events: eventStore }),
    claimNextCommand,
    oldestRunnableCommandAt,
    renewCommandClaim,
    releaseCommandClaim,
    completeCommand,
  }
}
