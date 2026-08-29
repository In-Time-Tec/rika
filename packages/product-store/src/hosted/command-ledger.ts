import * as PgClient from "@effect/sql-pg/PgClient"
import { PromptPart } from "@rika/product/execution-request"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import {
  HostedCommandLedger,
  type AdmitPromptInput,
  type AppendEventInput,
  type AppendRecoveredEventInput,
  type HostedCommandLedgerService,
} from "@rika/product/hosted-command-ledger"
import {
  ActorAttribution,
  CommitCursor,
  ExecutorInstanceId,
  JsonObject,
  OwnerId,
  Sequence,
  ThreadCommand,
  ThreadEvent,
  ThreadId,
} from "@rika/product/hosted-model"
import * as HostedObservability from "@rika/product/hosted-observability"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { TurnId } from "@rika/product/turn-record"
import { and, eq, gt, inArray, or, sql, type SQLWrapper } from "drizzle-orm"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Layer, Schema } from "effect"
import type { Row as SqlRow } from "effect/unstable/sql/SqlConnection"
import {
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperations,
  rikaHostedOwnerCounters,
  rikaHostedPromptCancellations,
  rikaHostedThreadCommands,
  rikaHostedThreadEvents,
  rikaHostedThreads,
  rikaThreadQueueState,
  rikaThreads,
  rikaTurns,
} from "../database/schema/product"
import { requireThreadAccess } from "./authority"

const timestamp = (value: string) => sql<Date>`${value}::timestamptz`
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
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRouteSnapshot)
const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
const AdmissionStatus = Schema.Literals(["accepted", "queued"])
const ExistingAdmissionRow = Schema.Struct({ turnId: Schema.String, admissionStatus: AdmissionStatus })
const commandFields = {
  ownerId: rikaHostedThreadCommands.ownerId,
  threadId: rikaHostedThreadCommands.threadId,
  commandId: rikaHostedThreadCommands.commandId,
  idempotencyKey: rikaHostedThreadCommands.idempotencyKey,
  actor: rikaHostedThreadCommands.actor,
  sequence: sql<string>`${rikaHostedThreadCommands.sequence}::text`,
  commitCursor: sql<string>`${rikaHostedThreadCommands.commitCursor}::text`,
  command: rikaHostedThreadCommands.command,
  admittedAt: timestampText(rikaHostedThreadCommands.admittedAt),
}
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
const commandEquivalent = Schema.toEquivalence(
  Schema.Struct({
    ownerId: ThreadCommand.fields.ownerId,
    threadId: ThreadCommand.fields.threadId,
    commandId: ThreadCommand.fields.commandId,
    idempotencyKey: ThreadCommand.fields.idempotencyKey,
    actor: ActorAttribution,
    command: JsonObject,
  }),
)
const actorEquivalent = Schema.toEquivalence(ActorAttribution)
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

const allocateCommitCursor = Effect.fn("HostedCommandLedger.allocateCommitCursor")(function* (
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

const make = Effect.gen(function* (): Effect.fn.Return<HostedCommandLedgerService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const cancelPrompt: HostedCommandLedgerService["cancelPrompt"] = Effect.fn("HostedCommandLedger.cancelPrompt")(
    function* (input) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const locked = yield* query(
              tx
                .select({ id: rikaHostedThreads.id })
                .from(rikaHostedThreads)
                .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedThreads.ownerId, input.ownerId)))
                .for("update"),
            )
            if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist for the owner")
            yield* requireThreadAccess(tx, input, "thread:control", input.cancelledAt)
            const cancellations = yield* query(
              tx
                .select({
                  targetCommandId: rikaHostedPromptCancellations.targetCommandId,
                  cancelCommandId: rikaHostedPromptCancellations.cancelCommandId,
                  actor: rikaHostedPromptCancellations.actor,
                })
                .from(rikaHostedPromptCancellations)
                .where(
                  and(
                    eq(rikaHostedPromptCancellations.threadId, input.threadId),
                    or(
                      eq(rikaHostedPromptCancellations.targetCommandId, input.targetCommandId),
                      eq(rikaHostedPromptCancellations.cancelCommandId, input.cancelCommandId),
                    ),
                  ),
                )
                .for("update"),
            )
            if (cancellations.length > 1)
              return yield* failure("conflict", "Cancellation identities refer to different submissions")
            const existing = cancellations[0]
            if (existing !== undefined) {
              const actor = yield* Schema.decodeUnknownEffect(ActorAttribution)(existing.actor).pipe(
                Effect.mapError(databaseError),
              )
              if (
                existing.targetCommandId !== input.targetCommandId ||
                existing.cancelCommandId !== input.cancelCommandId ||
                !actorEquivalent(actor, input.actor)
              )
                return yield* failure("conflict", "Cancellation identity was reused with incompatible input")
            } else {
              yield* query(
                tx.insert(rikaHostedPromptCancellations).values({
                  ownerId: input.ownerId,
                  threadId: input.threadId,
                  targetCommandId: input.targetCommandId,
                  cancelCommandId: input.cancelCommandId,
                  actor: input.actor,
                  cancelledAt: timestamp(input.cancelledAt),
                }),
              )
            }
            const targets = yield* query(
              tx
                .select({
                  turnId: rikaHostedThreadCommands.turnId,
                  tag: sql<string | null>`${rikaHostedThreadCommands.command} ->> '_tag'`,
                })
                .from(rikaHostedThreadCommands)
                .where(
                  and(
                    eq(rikaHostedThreadCommands.ownerId, input.ownerId),
                    eq(rikaHostedThreadCommands.threadId, input.threadId),
                    eq(rikaHostedThreadCommands.commandId, input.targetCommandId),
                  ),
                ),
            )
            const target = targets[0]
            if (target !== undefined && (target.tag !== "SubmitPrompt" || target.turnId === null))
              return yield* failure("conflict", "Cancellation target is not a prompt submission")
            return target?.turnId === undefined || target.turnId === null
              ? { _tag: "Pending" as const, targetCommandId: input.targetCommandId }
              : { _tag: "Turn" as const, targetCommandId: input.targetCommandId, turnId: TurnId.make(target.turnId) }
          }),
        )
        .pipe(Effect.catchTag("SqlError", databaseError))
    },
  )

  const admitPrompt = Effect.fn("HostedCommandLedger.admitPrompt")(function* (input: AdmitPromptInput) {
    if (input.prompt.length === 0) return yield* failure("conflict", "Prompt cannot be empty")
    const queueCapacity = Math.trunc(input.queueCapacity)
    if (queueCapacity < 1) return yield* failure("conflict", "Prompt queue capacity must be positive")
    const admittedAtMillis = Date.parse(input.admittedAt)
    if (!Number.isFinite(admittedAtMillis)) return yield* failure("conflict", "Prompt admission timestamp is invalid")
    const executionRoute = yield* Schema.encodeEffect(ExecutionRouteJson)(input.executionRoute).pipe(
      Effect.mapError(databaseError),
    )
    const promptParts =
      input.promptParts === undefined
        ? undefined
        : yield* Schema.encodeEffect(PromptPartsJson)(input.promptParts).pipe(Effect.mapError(databaseError))
    const command =
      input.promptParts === undefined
        ? { _tag: "SubmitPrompt" as const, prompt: input.prompt, mode: input.executionRoute.mode }
        : {
            _tag: "SubmitPrompt" as const,
            prompt: input.prompt,
            promptParts: input.promptParts,
            mode: input.executionRoute.mode,
          }
    const commandInput = {
      ownerId: input.ownerId,
      threadId: input.threadId,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      actor: input.actor,
      command,
      admittedAt: input.admittedAt,
    }
    let inserted = false
    const admitted = yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const locked = yield* query(
            tx
              .select({ id: rikaHostedThreads.id })
              .from(rikaHostedThreads)
              .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedThreads.ownerId, input.ownerId)))
              .for("update"),
          )
          if (locked[0] === undefined) return yield* failure("not-found", "Thread does not exist for the owner")
          yield* requireThreadAccess(tx, input, "thread:control", input.admittedAt)
          const existingRows = yield* query(
            tx
              .select({
                ...commandFields,
                turnId: rikaHostedThreadCommands.turnId,
                admissionStatus: rikaHostedThreadCommands.admissionStatus,
              })
              .from(rikaHostedThreadCommands)
              .where(
                and(
                  eq(rikaHostedThreadCommands.ownerId, input.ownerId),
                  eq(rikaHostedThreadCommands.threadId, input.threadId),
                  or(
                    eq(rikaHostedThreadCommands.commandId, input.commandId),
                    eq(rikaHostedThreadCommands.idempotencyKey, input.idempotencyKey),
                  ),
                ),
              ),
          )
          if (existingRows.length > 1)
            return yield* failure("conflict", "Command identity or idempotency key collides with multiple commands")
          if (existingRows[0] !== undefined) {
            const existing = yield* decode(ThreadCommand, existingRows[0])
            if (!commandEquivalent(existing, commandInput))
              return yield* failure("conflict", "Command identity or idempotency key was reused with different content")
            const admission = yield* decode(ExistingAdmissionRow, existingRows[0]).pipe(
              Effect.catch(() => failure("conflict", "Command identity was admitted without a Turn")),
            )
            return {
              _tag: "Admitted" as const,
              command: existing,
              turnId: TurnId.make(admission.turnId),
              status: admission.admissionStatus,
            }
          }
          const cancellation = yield* query(
            tx
              .select({ targetCommandId: rikaHostedPromptCancellations.targetCommandId })
              .from(rikaHostedPromptCancellations)
              .where(
                and(
                  eq(rikaHostedPromptCancellations.threadId, input.threadId),
                  eq(rikaHostedPromptCancellations.targetCommandId, input.commandId),
                ),
              ),
          )
          if (cancellation[0] !== undefined) return { _tag: "Cancelled" as const, targetCommandId: input.commandId }
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
                .returning({ queuedCount: rikaThreadQueueState.queuedCount }),
            )
            if (queueRows[0] === undefined) return yield* failure("conflict", "Thread prompt queue is full")
          }
          const sequences = yield* query(
            tx
              .update(rikaHostedThreads)
              .set({ nextCommandSequence: sql`${rikaHostedThreads.nextCommandSequence} + 1` })
              .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedThreads.ownerId, input.ownerId)))
              .returning({ sequence: sql<string>`(${rikaHostedThreads.nextCommandSequence} - 1)::text` }),
          )
          const sequence = Sequence.make(sequences[0]!.sequence)
          const commitCursor = yield* allocateCommitCursor(tx, input.ownerId)
          const rows = yield* query(
            tx
              .insert(rikaHostedThreadCommands)
              .values({
                ownerId: input.ownerId,
                threadId: input.threadId,
                commandId: input.commandId,
                idempotencyKey: input.idempotencyKey,
                turnId: input.turnId,
                admissionStatus: status,
                actor: input.actor,
                sequence: sql<number>`${sequence}::bigint`,
                commitCursor: sql<number>`${commitCursor}::bigint`,
                command,
                admittedAt: timestamp(input.admittedAt),
              })
              .returning(commandFields),
          )
          inserted = true
          return {
            _tag: "Admitted" as const,
            command: yield* decode(ThreadCommand, rows[0]),
            turnId: input.turnId,
            status,
          }
        }),
      )
      .pipe(Effect.catchTag("SqlError", databaseError))
    if (inserted && admitted._tag === "Admitted")
      yield* HostedObservability.event("admission", "success", {
        threadId: input.threadId,
        turnId: admitted.turnId,
      })
    return admitted
  })

  const appendEvent = Effect.fn("HostedCommandLedger.appendEvent")(function* (input: AppendEventInput) {
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

  const appendRecoveredEvent = Effect.fn("HostedCommandLedger.appendRecoveredEvent")(function* (
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
                  eq(rikaHostedExecutorOperations.state, "unknown"),
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

  return HostedCommandLedger.of({ admitPrompt, cancelPrompt, appendEvent, appendRecoveredEvent })
})

export const layer = Layer.effect(HostedCommandLedger, make)
