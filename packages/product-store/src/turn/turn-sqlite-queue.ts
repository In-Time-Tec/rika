import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { QueueFull, RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import type { AgentExecutionTurn } from "@rika/product/turn-record"
import { decodeAgent, decodeQueueState } from "./turn-row-codec"
import { repositoryError, submissionError } from "./turn-memory-errors"
type QueueSnapshot = Effect.Success<ReturnType<Interface["readQueue"]>>
type QueueClaim = Parameters<Interface["finishQueuedClaim"]>[0]
type QueueClaimFinish = Effect.Success<ReturnType<Interface["finishQueuedClaim"]>>
type QueueItemChange = Effect.Success<ReturnType<Interface["dequeue"]>>

export const makeTurnSqliteQueue = (
  sql: SqlClient,
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
    return yield* sql
      .withTransaction(
        Effect.gen(function* (): Effect.fn.Return<QueueSnapshot, SqlError | RepositoryError> {
          const stateRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${threadId}`
          const state = stateRows[0] === undefined ? undefined : yield* decodeQueueState(stateRows[0])
          const rows =
            yield* sql`SELECT * FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status = 'queued' ORDER BY created_at ASC, rowid ASC`
          const steeringRows =
            yield* sql`SELECT source_turn_id FROM rika_turn_steering_outbox WHERE thread_id = ${threadId} AND source_turn_id IS NOT NULL AND status != 'rejected'`
          const steering = new Set(
            steeringRows.map((row) => String((row as { readonly source_turn_id: unknown }).source_turn_id)),
          )
          const turns = yield* Effect.all(rows.map(decodeAgent)).pipe(
            Effect.map((decoded) =>
              decoded.map((turn) => (steering.has(String(turn.id)) ? { ...turn, delivery: "steer" as const } : turn)),
            ),
          )
          return {
            threadId,
            revision: state?.revision ?? 0,
            queuedCount: state?.queued_count ?? 0,
            turns,
          }
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  claimNextQueued: Effect.fn("TurnRepository.claimNextQueued")(function* (threadId, _now): Effect.fn.Return<
    QueueClaim | undefined,
    RepositoryError
  > {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`UPDATE rika_turns SET queue_claim_token = hex(randomblob(16))
          WHERE id = (SELECT id FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status = 'queued' AND queue_claim_token IS NULL
            AND NOT EXISTS (SELECT 1 FROM rika_turn_steering_outbox WHERE source_turn_id = rika_turns.id AND status != 'rejected')
            ORDER BY created_at ASC, rowid ASC LIMIT 1)
          AND turn_kind = 'AgentExecution'
          AND NOT EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status IN ('accepted', 'running', 'waiting', 'cancelling'))
          AND NOT EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND queue_claim_token IS NOT NULL)
          RETURNING *`
          if (rows[0] === undefined) return undefined
          const turn = yield* decodeAgent(rows[0])
          return { turn, token: String((rows[0] as { queue_claim_token: unknown }).queue_claim_token) }
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  finishQueuedClaim: Effect.fn("TurnRepository.finishQueuedClaim")(function* (claim, status, now): Effect.fn.Return<
    QueueClaimFinish,
    RepositoryError
  > {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`UPDATE rika_turns
      SET status = ${status}, updated_at = ${now}, queue_claim_token = NULL
      WHERE id = ${claim.turn.id} AND turn_kind = 'AgentExecution' AND status = 'queued' AND queue_claim_token = ${claim.token} RETURNING *`
          if (rows[0] === undefined) return { _tag: "Unavailable" as const }
          const turn = yield* decodeAgent(rows[0])
          const queueRows = yield* sql`UPDATE rika_thread_queue_state
      SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0)
      WHERE thread_id = ${turn.threadId} RETURNING *`
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
  releaseQueuedClaim: Effect.fn("TurnRepository.releaseQueuedClaim")(function* (claim): Effect.fn.Return<
    void,
    RepositoryError
  > {
    yield* sql`UPDATE rika_turns SET queue_claim_token = NULL
    WHERE id = ${claim.turn.id} AND turn_kind = 'AgentExecution' AND status = 'queued' AND queue_claim_token = ${claim.token}`.pipe(
      Effect.asVoid,
      Effect.mapError(repositoryError),
    )
  }),
  resetQueueClaims:
    sql`UPDATE rika_turns SET queue_claim_token = NULL WHERE turn_kind = 'AgentExecution' AND queue_claim_token IS NOT NULL`.pipe(
      Effect.asVoid,
      Effect.mapError(repositoryError),
    ),
  editQueued: Effect.fn("TurnRepository.editQueued")(function* (id, prompt, now): Effect.fn.Return<
    AgentExecutionTurn & { readonly queue: QueueItemChange },
    RepositoryError
  > {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql`UPDATE rika_turns SET prompt = ${prompt}, prompt_parts_json = NULL, updated_at = ${now}, queue_claim_token = NULL WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING *`
          if (rows[0] === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
          const turn = yield* decodeAgent(rows[0])
          const queueRows = yield* sql`UPDATE rika_thread_queue_state
          SET revision = revision + 1
          WHERE thread_id = ${turn.threadId}
          RETURNING *`
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
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql`DELETE FROM rika_turns WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING *`
          if (rows[0] === undefined) return yield* RepositoryError.make({ message: `Turn ${id} is not queued` })
          const turn = yield* decodeAgent(rows[0])
          const queueRows = yield* sql`UPDATE rika_thread_queue_state
          SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0)
          WHERE thread_id = ${turn.threadId}
          RETURNING *`
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
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const currentRows =
            yield* sql`SELECT * FROM rika_turns WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'accepted'`
          if (currentRows[0] === undefined)
            return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
          const current = yield* decodeAgent(currentRows[0])
          const otherActive = yield* sql`SELECT id FROM rika_turns
          WHERE thread_id = ${current.threadId} AND turn_kind = 'AgentExecution' AND id != ${id} AND status IN ('accepted', 'running', 'waiting', 'cancelling') LIMIT 1`
          if (otherActive[0] !== undefined)
            return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
          yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${current.threadId}) ON CONFLICT (thread_id) DO NOTHING`
          const queueRows = yield* sql`UPDATE rika_thread_queue_state
          SET revision = revision + 1, queued_count = queued_count + 1
          WHERE thread_id = ${current.threadId}
            AND queued_count < ${queueCapacity}
          RETURNING *`
          if (queueRows[0] === undefined) {
            const stateRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${current.threadId}`
            if (stateRows[0] === undefined)
              return yield* repositoryError(`Queue state ${current.threadId} does not exist`)
            const state = yield* decodeQueueState(stateRows[0])
            return yield* QueueFull.make({
              threadId: current.threadId,
              capacity: queueCapacity,
              count: state.queued_count,
            })
          }
          const updatedRows = yield* sql`UPDATE rika_turns SET status = 'queued', updated_at = ${now}
          WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'accepted' RETURNING *`
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
