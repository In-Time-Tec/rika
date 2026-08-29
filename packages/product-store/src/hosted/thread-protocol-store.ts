import * as PgClient from "@effect/sql-pg/PgClient"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { PromptPart } from "@rika/product/execution-request"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  max,
  min,
  notExists,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { alias } from "drizzle-orm/pg-core"
import { Effect, Layer, Schema } from "effect"
import {
  ActorAttribution,
  BetterAuthUserId,
  ClientId,
  CommitCursor,
  CommandId,
  DeviceId,
  IdempotencyKey,
  JsonObject,
  OwnerId,
  Sequence,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "@rika/product/hosted-model"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { InteractiveEventSchema } from "@rika/product/interactive-event"
import { HostedThreadSnapshot } from "@rika/product/client-protocol"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId } from "@rika/product/turn-record"
import {
  ThreadProtocolStore,
  type ThreadProtocolCommand,
  type ThreadProtocolEvent,
  type ThreadProtocolStoreService,
} from "@rika/product/thread-protocol-store"
import {
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedOwnerCounters,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolCursors,
  rikaHostedThreadProtocolEvents,
  rikaHostedThreadProtocolSnapshots,
  rikaHostedThreadProtocolState,
  rikaHostedThreads,
  rikaHostedThreadSocketTickets,
  rikaThreadQueueState,
  rikaThreads,
  rikaTurns,
} from "../database/schema/product"
import { requireThreadAccess } from "./authority"

const databaseError = (cause: unknown) =>
  HostedPersistenceError.make({
    reason: "database",
    message: `Thread protocol PostgreSQL operation failed: ${String(cause)}`,
  })
const failure = (reason: HostedPersistenceError["reason"], message: string) =>
  HostedPersistenceError.make({ reason, message })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const decode =
  <S extends Schema.Top>(schema: S) =>
  <Value>(value: Value) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(databaseError))
const jsonEquivalent = Schema.toEquivalence(JsonObject)
const actorEquivalent = Schema.toEquivalence(ActorAttribution)
const SubmitPromptIdentity = Schema.TaggedStruct("SubmitPrompt", {})
const CommandCancellationIdentity = Schema.TaggedStruct("Cancel", {
  target: Schema.TaggedStruct("Command", { commandId: Schema.String }),
})
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRouteSnapshot)
const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
const ExecutionLinkJson = Schema.fromJsonString(ExecutionGateway.ExecutionLink)
const PreparedTurnJson = Schema.fromJsonString(ExecutionGateway.PreparedTurn)
const bigintText = (column: SQLWrapper) => sql<string>`${column}::text`
const bigintValue = (value: string) => sql<number>`${value}::bigint`
const timestampValue = (value: string) => sql<Date>`${value}::timestamptz`
const timestampText = (column: SQLWrapper) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`

const commandFields = {
  ownerId: rikaHostedThreadProtocolCommands.ownerId,
  threadId: rikaHostedThreadProtocolCommands.threadId,
  commandId: rikaHostedThreadProtocolCommands.commandId,
  turnId: rikaHostedThreadProtocolCommands.turnId,
  idempotencyKey: rikaHostedThreadProtocolCommands.idempotencyKey,
  expectedThreadVersion: bigintText(rikaHostedThreadProtocolCommands.expectedVersion),
  threadVersion: bigintText(rikaHostedThreadProtocolCommands.threadVersion),
  commitCursor: bigintText(rikaHostedThreadProtocolCommands.commitCursor),
  actor: rikaHostedThreadProtocolCommands.actor,
  command: rikaHostedThreadProtocolCommands.command,
  state: rikaHostedThreadProtocolCommands.state,
  workState: rikaHostedThreadProtocolCommands.workState,
  admissionStatus: rikaHostedThreadProtocolCommands.admissionStatus,
  cancelledByCommandId: rikaHostedThreadProtocolCommands.cancelledByCommandId,
  result: rikaHostedThreadProtocolCommands.result,
  cursor: bigintText(rikaHostedThreadProtocolCommands.eventCursor),
  admittedAt: timestampText(rikaHostedThreadProtocolCommands.admittedAt),
  completedAt: timestampText(rikaHostedThreadProtocolCommands.completedAt),
}

interface CommandRow {
  readonly ownerId: string
  readonly threadId: string
  readonly commandId: string
  readonly turnId: string | null
  readonly idempotencyKey: string
  readonly expectedThreadVersion: string
  readonly threadVersion: string
  readonly commitCursor: string
  readonly actor: unknown
  readonly command: unknown
  readonly state: string
  readonly workState: string | null
  readonly admissionStatus: string | null
  readonly cancelledByCommandId: string | null
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
    sequence: Sequence.make(row.threadVersion),
    commitCursor: CommitCursor.make(row.commitCursor),
    actor: yield* decode(ActorAttribution)(row.actor),
    command: yield* decode(JsonObject)(row.command),
    state: yield* decode(Schema.Literals(["admitted", "completed"]))(row.state),
    admittedAt: Timestamp.make(row.admittedAt),
  }
  if (row.turnId !== null) Object.assign(command, { turnId: TurnId.make(row.turnId) })
  if (row.workState !== null)
    Object.assign(command, {
      workState: yield* decode(Schema.Literals(["turn-activation-pending", "turn-activation-requested"]))(
        row.workState,
      ),
    })
  if (row.admissionStatus !== null)
    Object.assign(command, {
      admissionStatus: yield* decode(Schema.Literals(["accepted", "queued"]))(row.admissionStatus),
    })
  if (row.cancelledByCommandId !== null)
    Object.assign(command, { cancelledByCommandId: CommandId.make(row.cancelledByCommandId) })
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
              (expectedVersion !== undefined && existing.expectedThreadVersion !== expectedVersion) ||
              !actorEquivalent(existing.actor, input.actor) ||
              !jsonEquivalent(existing.command, input.command)
            )
              return yield* failure("conflict", "Command identity was reused with incompatible input")
            return { _tag: "Duplicate" as const, command: existing }
          }
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

  const applyPrompt: ThreadProtocolStoreService["applyPrompt"] = Effect.fn("ThreadProtocolStore.applyPrompt")(
    function* (input, stage) {
      if (input.prompt.length === 0) return yield* failure("conflict", "Prompt cannot be empty")
      if (input.prepared.threadId !== input.threadId || input.prepared.turnId !== input.turnId)
        return yield* failure("conflict", "Prepared Runtime admission identifies a different Turn")
      const queueCapacity = Math.trunc(input.queueCapacity)
      if (queueCapacity < 1) return yield* failure("conflict", "Prompt queue capacity must be positive")
      const admittedAtMillis = Date.parse(input.completedAt)
      if (!Number.isFinite(admittedAtMillis)) return yield* failure("conflict", "Prompt admission timestamp is invalid")
      const executionRoute = yield* Schema.encodeEffect(ExecutionRouteJson)(input.executionRoute).pipe(
        Effect.mapError(databaseError),
      )
      const promptParts =
        input.promptParts === undefined
          ? undefined
          : yield* Schema.encodeEffect(PromptPartsJson)(input.promptParts).pipe(Effect.mapError(databaseError))
      const preparedTurn = yield* Schema.encodeEffect(PreparedTurnJson)(input.prepared).pipe(
        Effect.mapError(databaseError),
      )
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
            if (!actorEquivalent(currentCommand.actor, input.actor))
              return yield* failure("conflict", "Command actor does not match its durable admission")
            if (currentCommand.turnId !== undefined && currentCommand.turnId !== input.turnId)
              return yield* failure("conflict", "Command identifies a different Turn")
            if (current.state === "completed") {
              if (current.cancelledByCommandId !== null) return { _tag: "Cancelled" as const, command: currentCommand }
              const persisted = (yield* query(
                tx
                  .select({ link: rikaTurns.executionLinkJson })
                  .from(rikaTurns)
                  .where(and(eq(rikaTurns.id, input.turnId), eq(rikaTurns.threadId, input.threadId))),
              ))[0]
              if (persisted?.link === null || persisted === undefined || currentCommand.admissionStatus === undefined)
                return yield* failure("conflict", "Completed prompt command has no durable Runtime admission")
              return {
                _tag: "Admitted" as const,
                command: currentCommand,
                turnId: input.turnId,
                status: currentCommand.admissionStatus,
                link: yield* Schema.decodeEffect(ExecutionLinkJson)(persisted.link).pipe(
                  Effect.mapError(databaseError),
                ),
              }
            }
            if (
              input.claimToken !== undefined &&
              (current.claimToken !== input.claimToken || current.claimActive !== true)
            )
              return yield* failure("stale-fence", "Command application claim is expired or fenced")
            if (!Schema.is(SubmitPromptIdentity)(current.command))
              return yield* failure("conflict", "Command is not a prompt submission")
            const cancellation = (yield* query(
              tx
                .select({ commandId: rikaHostedThreadProtocolCommands.commandId })
                .from(rikaHostedThreadProtocolCommands)
                .where(
                  and(
                    eq(rikaHostedThreadProtocolCommands.ownerId, input.ownerId),
                    eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
                    sql`${rikaHostedThreadProtocolCommands.command} ->> '_tag' = 'Cancel'`,
                    sql`${rikaHostedThreadProtocolCommands.command} -> 'target' ->> '_tag' = 'Command'`,
                    sql`${rikaHostedThreadProtocolCommands.command} -> 'target' ->> 'commandId' = ${input.commandId}`,
                    or(
                      eq(rikaHostedThreadProtocolCommands.state, "admitted"),
                      and(
                        eq(rikaHostedThreadProtocolCommands.state, "completed"),
                        sql`${rikaHostedThreadProtocolCommands.result} ->> '_tag' = 'Applied'`,
                      ),
                    ),
                  ),
                )
                .orderBy(asc(rikaHostedThreadProtocolCommands.threadVersion))
                .limit(1),
            ))[0]
            if (cancellation !== undefined) {
              const cancelled = yield* query(
                tx
                  .update(rikaHostedThreadProtocolCommands)
                  .set({
                    state: "completed",
                    result: { _tag: "Applied" },
                    eventCursor: bigintValue(state.cursor),
                    completedAt: timestampValue(input.completedAt),
                    cancelledByCommandId: cancellation.commandId,
                    claimToken: null,
                    claimExpiresAt: null,
                  })
                  .where(
                    and(
                      eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
                      eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
                    ),
                  )
                  .returning(commandFields),
              )
              return { _tag: "Cancelled" as const, command: yield* commandRow(cancelled[0]!) }
            }
            if (!input.readinessProof) return yield* failure("database", "Prompt admission workers are unavailable")
            const productThread = yield* query(
              tx
                .select({ present: sql<number>`1` })
                .from(rikaThreads)
                .where(and(eq(rikaThreads.id, input.threadId), eq(rikaThreads.ownerId, input.ownerId)))
                .for("key share"),
            )
            if (productThread[0] === undefined)
              return yield* failure("invalid-authority", "Thread has no product state for the owner")
            const collidingTurn = yield* query(
              tx
                .select({ present: sql<number>`1` })
                .from(rikaTurns)
                .where(eq(rikaTurns.id, input.turnId)),
            )
            if (collidingTurn[0] !== undefined) return yield* failure("conflict", "Turn identity is already in use")
            const occupied = yield* query(
              tx
                .select({ present: sql<number>`1` })
                .from(rikaTurns)
                .where(
                  and(
                    eq(rikaTurns.threadId, input.threadId),
                    eq(rikaTurns.turnKind, "AgentExecution"),
                    inArray(rikaTurns.status, ["queued", "accepted", "running", "waiting", "cancelling"]),
                  ),
                )
                .limit(1),
            )
            const status = occupied[0] === undefined ? ("accepted" as const) : ("queued" as const)
            yield* query(
              tx.insert(rikaTurns).values({
                id: input.turnId,
                threadId: input.threadId,
                turnKind: "AgentExecution",
                prompt: input.prompt,
                promptPartsJson: promptParts ?? null,
                executionRouteJson: executionRoute,
                authorJson: '{"_tag":"Human"}',
                lineageJson: '{"_tag":"Original"}',
                status,
                createdAt: admittedAtMillis,
                updatedAt: admittedAtMillis,
              }),
            )
            yield* query(tx.insert(rikaThreadQueueState).values({ threadId: input.threadId }).onConflictDoNothing())
            if (status === "queued") {
              const queueRows = yield* query(
                tx
                  .update(rikaThreadQueueState)
                  .set({
                    revision: sql`${rikaThreadQueueState.revision} + 1`,
                    queuedCount: sql`${rikaThreadQueueState.queuedCount} + 1`,
                  })
                  .where(
                    and(
                      eq(rikaThreadQueueState.threadId, input.threadId),
                      sql`${rikaThreadQueueState.queuedCount} < ${queueCapacity}`,
                    ),
                  )
                  .returning({ threadId: rikaThreadQueueState.threadId }),
              )
              if (queueRows[0] === undefined) return yield* failure("conflict", "Thread prompt queue is full")
            }
            const link = yield* stage
            if (link.turnId !== input.turnId || link.threadId !== input.threadId)
              return yield* failure("conflict", "Runtime admission identifies a different Turn")
            const encodedLink = yield* Schema.encodeEffect(ExecutionLinkJson)(link).pipe(Effect.mapError(databaseError))
            yield* query(
              tx.update(rikaTurns).set({ executionLinkJson: encodedLink }).where(eq(rikaTurns.id, input.turnId)),
            )
            const events = yield* writeEvents(tx, {
              ownerId: input.ownerId,
              threadId: input.threadId,
              threadVersion: ThreadVersion.make(state.version),
              firstCursor: BigInt(state.cursor) + 1n,
              events: [
                {
                  _tag: "SubmissionAdmitted",
                  threadId: ProductThreadId.make(input.threadId),
                  turnId: input.turnId,
                  status: status === "accepted" ? "active" : "queued",
                  submissionId: input.submissionId,
                },
              ],
              createdAt: input.completedAt,
            })
            const cursor = events.at(-1)!.cursor
            yield* query(
              tx
                .update(rikaHostedThreadProtocolState)
                .set({ eventCursor: bigintValue(cursor) })
                .where(eq(rikaHostedThreadProtocolState.threadId, input.threadId)),
            )
            const completed = yield* query(
              tx
                .update(rikaHostedThreadProtocolCommands)
                .set({
                  state: "completed",
                  result: { _tag: "PromptAdmitted", status },
                  eventCursor: bigintValue(cursor),
                  completedAt: timestampValue(input.completedAt),
                  turnId: input.turnId,
                  admissionStatus: status,
                  workState: "turn-activation-pending",
                  preparedTurnJson: preparedTurn,
                  claimToken: null,
                  claimExpiresAt: null,
                })
                .where(
                  and(
                    eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
                    eq(rikaHostedThreadProtocolCommands.commandId, input.commandId),
                  ),
                )
                .returning(commandFields),
            )
            return {
              _tag: "Admitted" as const,
              command: yield* commandRow(completed[0]!),
              turnId: input.turnId,
              status,
              link,
            }
          }),
        )
        .pipe(Effect.catchTag("SqlError", databaseError))
    },
  )

  const cancelPrompt: ThreadProtocolStoreService["cancelPrompt"] = Effect.fn("ThreadProtocolStore.cancelPrompt")(
    function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* requireThreadAccess(tx, input, "thread:control", input.cancelledAt)
            const state = (yield* stateForUpdate(tx, input.ownerId, input.threadId))[0]
            if (state === undefined) return yield* failure("not-found", "Thread protocol state is unavailable")
            const cancel = (yield* query(
              tx
                .select({
                  actor: rikaHostedThreadProtocolCommands.actor,
                  command: rikaHostedThreadProtocolCommands.command,
                  state: rikaHostedThreadProtocolCommands.state,
                  resultTag: sql<string | null>`${rikaHostedThreadProtocolCommands.result} ->> '_tag'`,
                  claimToken: rikaHostedThreadProtocolCommands.claimToken,
                  claimActive: sql<boolean>`${rikaHostedThreadProtocolCommands.claimExpiresAt} > transaction_timestamp()`,
                })
                .from(rikaHostedThreadProtocolCommands)
                .where(
                  and(
                    eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
                    eq(rikaHostedThreadProtocolCommands.commandId, input.cancelCommandId),
                  ),
                )
                .for("update"),
            ))[0]
            if (cancel === undefined || !Schema.is(CommandCancellationIdentity)(cancel.command))
              return yield* failure("conflict", "Cancellation command does not identify the target")
            if (cancel.command.target.commandId !== input.targetCommandId)
              return yield* failure("conflict", "Cancellation command does not identify the target")
            const cancelActor = yield* decode(ActorAttribution)(cancel.actor)
            if (!actorEquivalent(cancelActor, input.actor))
              return yield* failure("conflict", "Cancellation actor does not match its durable admission")
            if (cancel.state === "completed" && cancel.resultTag !== "Applied")
              return yield* failure("conflict", "Rejected cancellation cannot be applied")
            if (
              input.claimToken !== undefined &&
              (cancel.claimToken !== input.claimToken || cancel.claimActive !== true)
            )
              return yield* failure("stale-fence", "Cancellation command claim is expired or fenced")
            if (input.claimToken === undefined && cancel.state === "admitted")
              yield* query(
                tx
                  .update(rikaHostedThreadProtocolCommands)
                  .set({
                    state: "completed",
                    result: { _tag: "Applied" },
                    eventCursor: bigintValue(state.cursor),
                    completedAt: timestampValue(input.cancelledAt),
                  })
                  .where(
                    and(
                      eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
                      eq(rikaHostedThreadProtocolCommands.commandId, input.cancelCommandId),
                    ),
                  ),
              )
            const target = (yield* query(
              tx
                .select({ ...commandFields, tag: sql<string>`${rikaHostedThreadProtocolCommands.command} ->> '_tag'` })
                .from(rikaHostedThreadProtocolCommands)
                .where(
                  and(
                    eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
                    eq(rikaHostedThreadProtocolCommands.commandId, input.targetCommandId),
                  ),
                )
                .for("update"),
            ))[0]
            if (target === undefined) return { _tag: "Pending" as const, targetCommandId: input.targetCommandId }
            if (target.tag !== "SubmitPrompt")
              return yield* failure("conflict", "Cancellation target is not a prompt submission")
            if (target.state === "admitted")
              yield* query(
                tx
                  .update(rikaHostedThreadProtocolCommands)
                  .set({
                    state: "completed",
                    result: { _tag: "Applied" },
                    eventCursor: bigintValue(state.cursor),
                    completedAt: timestampValue(input.cancelledAt),
                    cancelledByCommandId: input.cancelCommandId,
                    claimToken: null,
                    claimExpiresAt: null,
                  })
                  .where(
                    and(
                      eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
                      eq(rikaHostedThreadProtocolCommands.commandId, input.targetCommandId),
                    ),
                  ),
              )
            return target.turnId === null || target.state !== "completed" || target.admissionStatus === null
              ? { _tag: "Pending" as const, targetCommandId: input.targetCommandId }
              : {
                  _tag: "Turn" as const,
                  targetCommandId: input.targetCommandId,
                  turnId: TurnId.make(target.turnId),
                }
          }),
        )
        .pipe(Effect.catchTag("SqlError", databaseError))
    },
  )

  const claimNextCommand: ThreadProtocolStoreService["claimNextCommand"] = Effect.fn(
    "ThreadProtocolStore.claimNextCommand",
  )(function* (input) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const predecessor = alias(rikaHostedThreadProtocolCommands, "predecessor")
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
          if (input.snapshot !== undefined)
            yield* query(
              tx
                .insert(rikaHostedThreadProtocolSnapshots)
                .values({
                  ownerId: input.ownerId,
                  threadId: input.threadId,
                  threadVersion: bigintValue(threadVersion),
                  cursor: bigintValue(cursor),
                  snapshot: input.snapshot,
                  createdAt: timestampValue(input.completedAt),
                })
                .onConflictDoUpdate({
                  target: [rikaHostedThreadProtocolSnapshots.threadId, rikaHostedThreadProtocolSnapshots.threadVersion],
                  set: {
                    cursor: bigintValue(cursor),
                    snapshot: input.snapshot,
                    createdAt: timestampValue(input.completedAt),
                  },
                  setWhere: lte(rikaHostedThreadProtocolSnapshots.cursor, sql<number>`excluded.cursor`),
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
                  target: [rikaHostedThreadProtocolSnapshots.threadId, rikaHostedThreadProtocolSnapshots.threadVersion],
                  set: {
                    cursor: bigintValue(cursor),
                    snapshot: input.snapshot,
                    createdAt: timestampValue(input.createdAt),
                  },
                  setWhere: lte(rikaHostedThreadProtocolSnapshots.cursor, sql<number>`excluded.cursor`),
                }),
            )
            return events
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
                  target: [rikaHostedThreadProtocolSnapshots.threadId, rikaHostedThreadProtocolSnapshots.threadVersion],
                  set: {
                    cursor: bigintValue(input.cursor),
                    snapshot: input.snapshot,
                    createdAt: timestampValue(input.createdAt),
                  },
                  setWhere: lte(rikaHostedThreadProtocolSnapshots.cursor, sql<number>`excluded.cursor`),
                }),
            )
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
  })

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
          return ThreadEventCursor.make(rows[0]!.cursor)
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

  return ThreadProtocolStore.of({
    initializeThread,
    admitCommand,
    admitServerCommand,
    applyPrompt,
    cancelPrompt,
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
