import { and, count, eq, inArray, isNotNull, ne, sql as expression } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Schema } from "effect"
import { QueueFull } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { rikaThreadQueueState, rikaTurnSteeringOutbox, rikaTurns } from "../../database/schema/product"
import { decodeAgent, decodeQueueState } from "./row-codec"
import { turnRowSelection } from "./reader"
import { turnRowJson } from "./row-json-codec"
import { repositoryError, submissionError } from "../memory/errors"

const queueSelection = {
  thread_id: rikaThreadQueueState.threadId,
  revision: rikaThreadQueueState.revision,
  queued_count: rikaThreadQueueState.queuedCount,
}

const reserveQueueEntry = (
  db: PgDrizzle.EffectPgDatabase,
  threadId: Parameters<Interface["createForSubmission"]>[0]["threadId"],
  capacity: number,
) =>
  Effect.gen(function* () {
    yield* db.insert(rikaThreadQueueState).values({ threadId }).onConflictDoNothing()
    const reserved = db
      .select({ value: count() })
      .from(rikaTurnSteeringOutbox)
      .where(
        and(
          eq(rikaTurnSteeringOutbox.threadId, threadId),
          isNotNull(rikaTurnSteeringOutbox.sourceTurnId),
          ne(rikaTurnSteeringOutbox.status, "rejected"),
          eq(rikaTurnSteeringOutbox.sourceWithdrawn, 1),
        ),
      )
    const rows = yield* db
      .update(rikaThreadQueueState)
      .set({
        revision: expression`${rikaThreadQueueState.revision} + 1`,
        queuedCount: expression`${rikaThreadQueueState.queuedCount} + 1`,
      })
      .where(
        and(
          eq(rikaThreadQueueState.threadId, threadId),
          expression`${rikaThreadQueueState.queuedCount} + (${reserved}) < ${capacity}`,
        ),
      )
      .returning(queueSelection)
    if (rows[0] !== undefined) return yield* decodeQueueState(rows[0])
    const states = yield* db
      .select(queueSelection)
      .from(rikaThreadQueueState)
      .where(eq(rikaThreadQueueState.threadId, threadId))
      .limit(1)
    if (states[0] === undefined) return yield* repositoryError(`Queue state ${threadId} does not exist`)
    const state = yield* decodeQueueState(states[0])
    const reservedRows = yield* reserved
    return yield* QueueFull.make({
      threadId,
      capacity,
      count: state.queued_count + (reservedRows[0]?.value ?? 0),
    })
  })

export const makeTurnSqlSubmission = (
  db: PgDrizzle.EffectPgDatabase,
): Pick<Interface, "createForSubmission" | "copy"> => ({
  createForSubmission: Effect.fn("TurnRepository.createForSubmission")(function* (input) {
    const promptParts =
      input.promptParts === undefined
        ? null
        : yield* Schema.encodeEffect(turnRowJson.promptParts)(input.promptParts).pipe(Effect.mapError(repositoryError))
    const executionRoute = yield* Schema.encodeEffect(turnRowJson.executionRoute)(input.executionRoute).pipe(
      Effect.mapError(repositoryError),
    )
    const author = yield* Schema.encodeEffect(turnRowJson.author)(input.author ?? { _tag: "Human" }).pipe(
      Effect.mapError(repositoryError),
    )
    const lineage = yield* Schema.encodeEffect(turnRowJson.lineage)(input.lineage ?? { _tag: "Original" }).pipe(
      Effect.mapError(repositoryError),
    )
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const active = tx
            .select({ id: rikaTurns.id })
            .from(rikaTurns)
            .where(
              and(
                eq(rikaTurns.threadId, input.threadId),
                eq(rikaTurns.turnKind, "AgentExecution"),
                inArray(rikaTurns.status, ["queued", "accepted", "running", "waiting", "cancelling"]),
              ),
            )
          const rows = yield* tx
            .insert(rikaTurns)
            .values({
              id: input.id,
              threadId: input.threadId,
              turnKind: "AgentExecution",
              prompt: input.prompt,
              promptPartsJson: promptParts,
              executionRouteJson: executionRoute,
              authorJson: author,
              lineageJson: lineage,
              status: expression`CASE WHEN EXISTS (${active}) THEN 'queued' ELSE 'accepted' END`,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .returning(turnRowSelection)
          const turn = yield* decodeAgent(rows[0])
          if (turn.status !== "queued") return turn
          const state = yield* reserveQueueEntry(tx, input.threadId, input.queueCapacity)
          return {
            ...turn,
            queue: {
              threadId: input.threadId,
              revision: state.revision,
              queuedCount: state.queued_count,
              becameNonempty: state.queued_count === 1,
              change: { _tag: "Added" as const, turn },
            },
          }
        }),
      )
      .pipe(Effect.mapError(submissionError))
  }),
  copy: Effect.fn("TurnRepository.copy")(function* (turn, queueCapacity) {
    const promptParts =
      turn.promptParts === undefined
        ? null
        : yield* Schema.encodeEffect(turnRowJson.promptParts)(turn.promptParts).pipe(Effect.mapError(repositoryError))
    const executionRoute = yield* Schema.encodeEffect(turnRowJson.executionRoute)(turn.executionRoute).pipe(
      Effect.mapError(repositoryError),
    )
    const author = yield* Schema.encodeEffect(turnRowJson.author)(turn.author).pipe(Effect.mapError(repositoryError))
    const lineage = yield* Schema.encodeEffect(turnRowJson.lineage)(turn.lineage).pipe(Effect.mapError(repositoryError))
    const executionLink =
      turn.executionLink === undefined
        ? null
        : yield* Schema.encodeEffect(turnRowJson.executionLink)(turn.executionLink).pipe(
            Effect.mapError(repositoryError),
          )
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx.insert(rikaTurns).values({
            id: turn.id,
            threadId: turn.threadId,
            turnKind: "AgentExecution",
            prompt: turn.prompt,
            promptPartsJson: promptParts,
            status: turn.status,
            executionRouteJson: executionRoute,
            executionLinkJson: executionLink,
            authorJson: author,
            lineageJson: lineage,
            createdAt: turn.createdAt,
            updatedAt: turn.updatedAt,
          })
          if (turn.status !== "queued") return turn
          const state = yield* reserveQueueEntry(tx, turn.threadId, queueCapacity)
          return {
            ...turn,
            queue: {
              threadId: turn.threadId,
              revision: state.revision,
              queuedCount: state.queued_count,
              becameNonempty: state.queued_count === 1,
              change: { _tag: "Added" as const, turn },
            },
          }
        }),
      )
      .pipe(Effect.mapError(submissionError))
  }),
})
