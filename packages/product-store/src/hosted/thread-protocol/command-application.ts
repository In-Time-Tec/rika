import { ActorAttribution, ThreadVersion } from "@rika/product/hosted-model"
import type { ThreadProtocolStoreService } from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId } from "@rika/product/turn-record"
import { and, asc, eq, inArray, or, sql } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import {
  rikaHostedThreadProtocolCommands,
  rikaHostedThreadProtocolState,
  rikaThreadQueueState,
  rikaThreads,
  rikaTurns,
} from "../../database/schema/product"
import { requireThreadAccess } from "../authority"
import {
  CommandCancellationIdentity,
  ExecutionLinkJson,
  ExecutionRouteJson,
  PreparedTurnJson,
  PromptPartsJson,
  SubmitPromptIdentity,
  bigintValue,
  commandFields,
  commandRow,
  databaseError,
  decode,
  every,
  persistenceErrors,
  protocolEquivalence,
  query,
  timestampValue,
} from "./persistence"
import type { eventOperations } from "./events"

type EventOperations = ReturnType<typeof eventOperations>

export const commandApplicationOperations = ({
  db,
  events: eventStore,
}: {
  db: PgDrizzle.EffectPgDatabase
  events: EventOperations
}) => {
  const { failure } = persistenceErrors
  const { actor: actorEquivalent } = protocolEquivalence
  const { stateForUpdate, writeEvents } = eventStore
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
            if (every(currentCommand.turnId !== undefined, currentCommand.turnId !== input.turnId))
              return yield* failure("conflict", "Command identifies a different Turn")
            const completedApplication = Effect.gen(function* () {
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
            })
            if (current.state === "completed") {
              return yield* completedApplication
            }
            if (
              every(
                input.claimToken !== undefined,
                !every(current.claimToken === input.claimToken, current.claimActive === true),
              )
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
            const admitTurn = Effect.fn("ThreadProtocolStore.admitTurn")(function* () {
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
              const admissionStatus = occupied[0] === undefined ? ("accepted" as const) : ("queued" as const)
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
                  status: admissionStatus,
                  createdAt: admittedAtMillis,
                  updatedAt: admittedAtMillis,
                }),
              )
              yield* query(tx.insert(rikaThreadQueueState).values({ threadId: input.threadId }).onConflictDoNothing())
              if (admissionStatus === "queued") {
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
              return admissionStatus
            })
            const status = yield* admitTurn()
            const link = yield* stage
            if (!every(link.turnId === input.turnId, link.threadId === input.threadId))
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
            if (every(cancel.state === "completed", cancel.resultTag !== "Applied"))
              return yield* failure("conflict", "Rejected cancellation cannot be applied")
            if (
              every(
                input.claimToken !== undefined,
                !every(cancel.claimToken === input.claimToken, cancel.claimActive === true),
              )
            )
              return yield* failure("stale-fence", "Cancellation command claim is expired or fenced")
            if (every(input.claimToken === undefined, cancel.state === "admitted"))
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

  return { applyPrompt, cancelPrompt }
}
