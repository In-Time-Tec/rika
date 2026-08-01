import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { QueueFull, QueuedTurnUnavailable, RepositoryError } from "@rika/product/turn-repository"
import type {
  Interface,
  QueueSnapshot,
  QueueClaim,
  QueueClaimFinish,
  QueueItemChange,
  QueuedTurnTake,
  QueueWake,
} from "@rika/product/turn-repository"
import type { AgentExecutionTurn } from "@rika/product/turn-record"
import { decodeAgent, decodeQueueState, encodeExtensionPin } from "./turn-row-codec"
import { queuedTurnUnavailable, repositoryError, submissionError, takeQueuedError } from "./turn-memory-errors"
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
  | "takeQueued"
  | "dequeue"
  | "requeueAccepted"
  | "requestQueueWake"
  | "consumeQueueWake"
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
          const turns = yield* Effect.all(rows.map(decodeAgent))
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
          WHERE id = (SELECT id FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status = 'queued' AND queue_claim_token IS NULL ORDER BY created_at ASC, rowid ASC LIMIT 1)
          AND turn_kind = 'AgentExecution'
          AND NOT EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND status IN ('accepted', 'running', 'waiting'))
          AND NOT EXISTS (SELECT 1 FROM rika_turns WHERE thread_id = ${threadId} AND turn_kind = 'AgentExecution' AND queue_claim_token IS NOT NULL)
          RETURNING *`
          if (rows[0] === undefined) return undefined
          const turn = yield* decodeAgent(rows[0])
          return { turn, token: String((rows[0] as { queue_claim_token: unknown }).queue_claim_token) }
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  finishQueuedClaim: Effect.fn("TurnRepository.finishQueuedClaim")(
    function* (claim, status, lastCursor, extensionPin, now): Effect.fn.Return<QueueClaimFinish, RepositoryError> {
      const encodedPin = extensionPin === undefined ? undefined : yield* encodeExtensionPin(extensionPin)
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`UPDATE rika_turns
      SET status = ${status}, last_cursor = ${lastCursor ?? null}, extension_pin_json = COALESCE(extension_pin_json, ${encodedPin ?? null}), updated_at = ${now}, queue_claim_token = NULL
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
    },
  ),
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
  takeQueued: Effect.fn("TurnRepository.takeQueued")(function* (id): Effect.fn.Return<
    QueuedTurnTake,
    RepositoryError | QueuedTurnUnavailable
  > {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows =
            yield* sql`DELETE FROM rika_turns WHERE id = ${id} AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING *`
          if (rows[0] === undefined) return yield* queuedTurnUnavailable(id)
          const turn = yield* decodeAgent(rows[0])
          const queueRows = yield* sql`UPDATE rika_thread_queue_state
          SET revision = revision + 1, queued_count = MAX(queued_count - 1, 0)
          WHERE thread_id = ${turn.threadId}
          RETURNING *`
          if (queueRows[0] === undefined) return yield* repositoryError(`Queue state ${turn.threadId} does not exist`)
          const state = yield* decodeQueueState(queueRows[0])
          return {
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
      .pipe(Effect.mapError(takeQueuedError))
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
          WHERE thread_id = ${current.threadId} AND turn_kind = 'AgentExecution' AND id != ${id} AND status IN ('accepted', 'running', 'waiting') LIMIT 1`
          if (otherActive[0] !== undefined)
            return yield* RepositoryError.make({ message: `Turn ${id} is not an unowned accepted turn` })
          yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${current.threadId}) ON CONFLICT (thread_id) DO NOTHING`
          const queueRows = yield* sql`UPDATE rika_thread_queue_state
          SET revision = revision + 1, queued_count = queued_count + 1
          WHERE thread_id = ${current.threadId} AND queued_count < ${queueCapacity}
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
  requestQueueWake: Effect.fn("TurnRepository.requestQueueWake")(function* (threadId): Effect.fn.Return<
    QueueWake | undefined,
    RepositoryError
  > {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO rika_thread_queue_state (thread_id) VALUES (${threadId}) ON CONFLICT (thread_id) DO NOTHING`
          const existingRows = yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${threadId}`
          if (existingRows[0] === undefined) return yield* repositoryError(`Queue state ${threadId} does not exist`)
          const existing = yield* decodeQueueState(existingRows[0])
          if (existing.queued_count === 0) return undefined
          if (existing.wake_pending === 1)
            return { threadId, generation: existing.wake_generation, queueRevision: existing.revision }
          const rows = yield* sql`UPDATE rika_thread_queue_state
          SET wake_generation = wake_generation + 1, wake_pending = 1
          WHERE thread_id = ${threadId} AND queued_count > 0 AND wake_pending = 0
          RETURNING *`
          if (rows[0] === undefined) return undefined
          const state = yield* decodeQueueState(rows[0])
          return { threadId, generation: state.wake_generation, queueRevision: state.revision }
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  consumeQueueWake: Effect.fn("TurnRepository.consumeQueueWake")(function* (threadId, generation): Effect.fn.Return<
    boolean,
    RepositoryError
  > {
    const rows = yield* sql`UPDATE rika_thread_queue_state SET wake_pending = 0
    WHERE thread_id = ${threadId} AND wake_pending = 1 AND wake_generation = ${generation}
    RETURNING thread_id`.pipe(Effect.mapError(repositoryError))
    return rows[0] !== undefined
  }),
})
