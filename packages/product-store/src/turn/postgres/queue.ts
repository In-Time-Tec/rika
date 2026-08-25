import { QueueFull, RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import type { AgentExecutionTurn } from "@rika/product/turn-record"
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  sql as expression,
} from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Random } from "effect"
import {
  rikaThreadQueueState,
  rikaTurnSteeringOutbox,
  rikaTurns,
} from "../../database/schema/product"
import { decodeAgent, decodeQueueState } from "./row-codec"
import { repositoryError, submissionError } from "../memory/errors"

type QueueSnapshot = Effect.Success<ReturnType<Interface["readQueue"]>>
type QueueClaim = Parameters<Interface["finishQueuedClaim"]>[0]
type QueueClaimFinish = Effect.Success<ReturnType<Interface["finishQueuedClaim"]>>
type QueueItemChange = Effect.Success<ReturnType<Interface["dequeue"]>>

const turnFields = {
  id: rikaTurns.id,
  thread_id: rikaTurns.threadId,
  turn_kind: rikaTurns.turnKind,
  prompt: rikaTurns.prompt,
  status: rikaTurns.status,
  execution_route_json: rikaTurns.executionRouteJson,
  execution_link_json: rikaTurns.executionLinkJson,
  prompt_parts_json: rikaTurns.promptPartsJson,
  shell_command: rikaTurns.shellCommand,
  shell_result_text: rikaTurns.shellResultText,
  shell_result_truncated: rikaTurns.shellResultTruncated,
  shell_result_exit_code: rikaTurns.shellResultExitCode,
  author_json: rikaTurns.authorJson,
  lineage_json: rikaTurns.lineageJson,
  created_at: rikaTurns.createdAt,
  updated_at: rikaTurns.updatedAt,
}
const claimedTurnFields = { ...turnFields, queue_claim_token: rikaTurns.queueClaimToken }
const queueFields = {
  thread_id: rikaThreadQueueState.threadId,
  revision: rikaThreadQueueState.revision,
  queued_count: rikaThreadQueueState.queuedCount,
}
const eligibleQueued = (executor: PgDrizzle.EffectPgDatabase) =>
  and(
    eq(rikaTurns.turnKind, "AgentExecution"),
    eq(rikaTurns.status, "queued"),
    notExists(
      executor
        .select({ requestId: rikaTurnSteeringOutbox.requestId })
        .from(rikaTurnSteeringOutbox)
        .where(
          and(
            eq(rikaTurnSteeringOutbox.sourceTurnId, rikaTurns.id),
            ne(rikaTurnSteeringOutbox.status, "rejected"),
          ),
        ),
    ),
  )

export const makeTurnSqlQueue = (
  db: PgDrizzle.EffectPgDatabase,
): Pick<
  Interface,
  | "readQueue"
  | "claimNextQueued"
  | "finishQueuedClaim"
  | "releaseQueuedClaim"
  | "resetQueueClaims"
  | "editQueued"
  | "dequeue"
  | "requeueAccepted"
> => ({
  readQueue: Effect.fn("TurnRepository.readQueue")(function* (threadId): Effect.fn.Return<
    QueueSnapshot,
    RepositoryError
  > {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const stateRows = yield* tx
            .select(queueFields)
            .from(rikaThreadQueueState)
            .where(eq(rikaThreadQueueState.threadId, threadId))
          const state = stateRows[0] === undefined ? undefined : yield* decodeQueueState(stateRows[0])
          const rows = yield* tx
            .select(turnFields)
            .from(rikaTurns)
            .where(and(eq(rikaTurns.threadId, threadId), eligibleQueued(tx)))
            .orderBy(asc(rikaTurns.createdAt), asc(rikaTurns.id))
          const turns = yield* Effect.all(rows.map(decodeAgent))
          return { threadId, revision: state?.revision ?? 0, queuedCount: state?.queued_count ?? 0, turns }
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  claimNextQueued: Effect.fn("TurnRepository.claimNextQueued")(function* (threadId, now): Effect.fn.Return<
    QueueClaim | undefined,
    RepositoryError
  > {
    const token = `${threadId}:${now}:${yield* Random.nextInt}:${yield* Random.nextInt}`
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const queueRows = yield* tx
            .update(rikaThreadQueueState)
            .set({ revision: expression`${rikaThreadQueueState.revision}` })
            .where(eq(rikaThreadQueueState.threadId, threadId))
            .returning({ threadId: rikaThreadQueueState.threadId })
          if (queueRows[0] === undefined) return undefined
          const next = tx
            .select({ id: rikaTurns.id })
            .from(rikaTurns)
            .where(and(eq(rikaTurns.threadId, threadId), eligibleQueued(tx), isNull(rikaTurns.queueClaimToken)))
            .orderBy(asc(rikaTurns.createdAt), asc(rikaTurns.id))
            .limit(1)
          const active = tx
            .select({ id: rikaTurns.id })
            .from(rikaTurns)
            .where(
              and(
                eq(rikaTurns.threadId, threadId),
                eq(rikaTurns.turnKind, "AgentExecution"),
                inArray(rikaTurns.status, ["accepted", "running", "waiting", "cancelling"]),
              ),
            )
          const claimed = tx
            .select({ id: rikaTurns.id })
            .from(rikaTurns)
            .where(
              and(
                eq(rikaTurns.threadId, threadId),
                eq(rikaTurns.turnKind, "AgentExecution"),
                isNotNull(rikaTurns.queueClaimToken),
              ),
            )
          const rows = yield* tx
            .update(rikaTurns)
            .set({ queueClaimToken: token })
            .where(
              and(
                eq(rikaTurns.id, next),
                eq(rikaTurns.turnKind, "AgentExecution"),
                notExists(active),
                notExists(claimed),
              ),
            )
            .returning(claimedTurnFields)
          const row = rows[0]
          if (row === undefined || row.queue_claim_token === null) return undefined
          return { turn: yield* decodeAgent(row), token: row.queue_claim_token }
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  finishQueuedClaim: Effect.fn("TurnRepository.finishQueuedClaim")(function* (claim, status, now): Effect.fn.Return<
    QueueClaimFinish,
    RepositoryError
  > {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx
            .update(rikaTurns)
            .set({ status, updatedAt: now, queueClaimToken: null })
            .where(
              and(
                eq(rikaTurns.id, claim.turn.id),
                eq(rikaTurns.turnKind, "AgentExecution"),
                eq(rikaTurns.status, "queued"),
                eq(rikaTurns.queueClaimToken, claim.token),
              ),
            )
            .returning(turnFields)
          if (rows[0] === undefined) return { _tag: "Unavailable" as const }
          const turn = yield* decodeAgent(rows[0])
          const queueRows = yield* tx
            .update(rikaThreadQueueState)
            .set({
              revision: expression`${rikaThreadQueueState.revision} + 1`,
              queuedCount: expression`CASE WHEN ${rikaThreadQueueState.queuedCount} > 0 THEN ${rikaThreadQueueState.queuedCount} - 1 ELSE 0 END`,
            })
            .where(eq(rikaThreadQueueState.threadId, turn.threadId))
            .returning(queueFields)
          if (queueRows[0] === undefined) return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
          const state = yield* decodeQueueState(queueRows[0])
          return {
            _tag: "Transitioned" as const,
            turn,
            queue: {
              threadId: turn.threadId,
              revision: state.revision,
              queuedCount: state.queued_count,
              becameNonempty: false,
              change: { _tag: "Removed" as const, turnId: turn.id },
            },
          }
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  releaseQueuedClaim: Effect.fn("TurnRepository.releaseQueuedClaim")(function* (claim) {
    yield* db
      .update(rikaTurns)
      .set({ queueClaimToken: null })
      .where(
        and(
          eq(rikaTurns.id, claim.turn.id),
          eq(rikaTurns.turnKind, "AgentExecution"),
          eq(rikaTurns.status, "queued"),
          eq(rikaTurns.queueClaimToken, claim.token),
        ),
      )
      .pipe(Effect.asVoid, Effect.mapError(repositoryError))
  }),
  resetQueueClaims: db
    .update(rikaTurns)
    .set({ queueClaimToken: null })
    .where(and(eq(rikaTurns.turnKind, "AgentExecution"), isNotNull(rikaTurns.queueClaimToken)))
    .pipe(Effect.asVoid, Effect.mapError(repositoryError)),
  editQueued: Effect.fn("TurnRepository.editQueued")(function* (id, prompt, now): Effect.fn.Return<
    AgentExecutionTurn & { readonly queue: QueueItemChange },
    RepositoryError
  > {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx
            .update(rikaTurns)
            .set({ prompt, promptPartsJson: null, updatedAt: now, queueClaimToken: null })
            .where(and(eq(rikaTurns.id, id), eligibleQueued(tx)))
            .returning(turnFields)
          if (rows[0] === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
          const turn = yield* decodeAgent(rows[0])
          const queueRows = yield* tx
            .update(rikaThreadQueueState)
            .set({ revision: expression`${rikaThreadQueueState.revision} + 1` })
            .where(eq(rikaThreadQueueState.threadId, turn.threadId))
            .returning(queueFields)
          if (queueRows[0] === undefined) return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
          const state = yield* decodeQueueState(queueRows[0])
          return {
            ...turn,
            queue: {
              threadId: turn.threadId,
              revision: state.revision,
              queuedCount: state.queued_count,
              becameNonempty: false,
              change: { _tag: "Updated" as const, turn },
            },
          }
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  dequeue: Effect.fn("TurnRepository.dequeue")(function* (id): Effect.fn.Return<QueueItemChange, RepositoryError> {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx
            .delete(rikaTurns)
            .where(and(eq(rikaTurns.id, id), eligibleQueued(tx)))
            .returning(turnFields)
          if (rows[0] === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
          const turn = yield* decodeAgent(rows[0])
          const queueRows = yield* tx
            .update(rikaThreadQueueState)
            .set({
              revision: expression`${rikaThreadQueueState.revision} + 1`,
              queuedCount: expression`CASE WHEN ${rikaThreadQueueState.queuedCount} > 0 THEN ${rikaThreadQueueState.queuedCount} - 1 ELSE 0 END`,
            })
            .where(eq(rikaThreadQueueState.threadId, turn.threadId))
            .returning(queueFields)
          if (queueRows[0] === undefined) return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
          const state = yield* decodeQueueState(queueRows[0])
          return {
            threadId: turn.threadId,
            revision: state.revision,
            queuedCount: state.queued_count,
            becameNonempty: false,
            change: { _tag: "Removed" as const, turnId: turn.id },
          }
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  requeueAccepted: Effect.fn("TurnRepository.requeueAccepted")(function* (id, queueCapacity, now): Effect.fn.Return<
    AgentExecutionTurn & { readonly queue: QueueItemChange },
    RepositoryError | QueueFull
  > {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const currentRows = yield* tx
            .select(turnFields)
            .from(rikaTurns)
            .where(
              and(eq(rikaTurns.id, id), eq(rikaTurns.turnKind, "AgentExecution"), eq(rikaTurns.status, "accepted")),
            )
          if (currentRows[0] === undefined)
            return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
          const current = yield* decodeAgent(currentRows[0])
          const otherActive = yield* tx
            .select({ id: rikaTurns.id })
            .from(rikaTurns)
            .where(
              and(
                eq(rikaTurns.threadId, current.threadId),
                eq(rikaTurns.turnKind, "AgentExecution"),
                ne(rikaTurns.id, id),
                inArray(rikaTurns.status, ["accepted", "running", "waiting", "cancelling"]),
              ),
            )
            .limit(1)
          if (otherActive[0] !== undefined)
            return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
          yield* tx
            .insert(rikaThreadQueueState)
            .values({ threadId: current.threadId })
            .onConflictDoNothing({ target: rikaThreadQueueState.threadId })
          const reserved = tx
            .select({ value: count() })
            .from(rikaTurnSteeringOutbox)
            .where(
              and(
                eq(rikaTurnSteeringOutbox.threadId, current.threadId),
                isNotNull(rikaTurnSteeringOutbox.sourceTurnId),
                ne(rikaTurnSteeringOutbox.status, "rejected"),
                eq(rikaTurnSteeringOutbox.sourceWithdrawn, 1),
              ),
            )
          const queueRows = yield* tx
            .update(rikaThreadQueueState)
            .set({
              revision: expression`${rikaThreadQueueState.revision} + 1`,
              queuedCount: expression`${rikaThreadQueueState.queuedCount} + 1`,
            })
            .where(
              and(
                eq(rikaThreadQueueState.threadId, current.threadId),
                expression`${rikaThreadQueueState.queuedCount} + (${reserved}) < ${queueCapacity}`,
              ),
            )
            .returning(queueFields)
          if (queueRows[0] === undefined) {
            const stateRows = yield* tx
              .select(queueFields)
              .from(rikaThreadQueueState)
              .where(eq(rikaThreadQueueState.threadId, current.threadId))
            if (stateRows[0] === undefined)
              return yield* repositoryError(`Queue state ${current.threadId} does not exist`)
            const state = yield* decodeQueueState(stateRows[0])
            const reservedRows = yield* reserved
            return yield* QueueFull.make({
              threadId: current.threadId,
              capacity: queueCapacity,
              count: state.queued_count + (reservedRows[0]?.value ?? 0),
            })
          }
          const updatedRows = yield* tx
            .update(rikaTurns)
            .set({ status: "queued", updatedAt: now })
            .where(
              and(eq(rikaTurns.id, id), eq(rikaTurns.turnKind, "AgentExecution"), eq(rikaTurns.status, "accepted")),
            )
            .returning(turnFields)
          if (updatedRows[0] === undefined)
            return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
          const turn = yield* decodeAgent(updatedRows[0])
          const state = yield* decodeQueueState(queueRows[0])
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
