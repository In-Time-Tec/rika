import { Effect, Schema } from "effect"
import {
  ExecutionLink,
  PendingSteeringMaxEntries,
  SteeringFailure,
  SteeringInput,
  SteeringReceipt,
} from "@rika/product/execution-gateway"
import { QueuedTurnUnavailable, RepositoryError } from "@rika/product/turn-repository"
import type { Interface } from "@rika/product/turn-repository"
import { SteeringAdmission } from "@rika/product/turn-repository-steering"
import { TurnId } from "@rika/product/turn-record"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { decodeAgent, decodeQueueState } from "./turn-row-codec"
import { turnRowJson } from "./turn-row-json-codec"
import { queuedTurnUnavailable, repositoryError } from "./turn-memory-errors"

const Row = Schema.Struct({
  request_id: Schema.String,
  target_turn_id: Schema.String,
  source_turn_id: Schema.NullOr(Schema.String),
  admission_json: Schema.String,
  source_withdrawn: Schema.Finite,
  status: Schema.Literals(["pending", "accepted", "rejected"]),
})
const equivalentTarget = Schema.toEquivalence(ExecutionLink)
const equivalentInput = Schema.toEquivalence(SteeringInput)
const equivalentReceipt = Schema.toEquivalence(SteeringReceipt)
const equivalentFailure = Schema.toEquivalence(SteeringFailure)

const decodeAdmission = (row: unknown) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(Row)(row)
    const admission = yield* Schema.decodeUnknownEffect(turnRowJson.steeringAdmission)(value.admission_json)
    const status = admission.outcome._tag.toLowerCase()
    if (
      value.request_id !== admission.input.idempotencyKey ||
      value.target_turn_id !== admission.target.turnId ||
      value.source_turn_id !== (admission.source?.id ?? null) ||
      value.source_withdrawn !== Number(admission.sourceWithdrawn === true) ||
      value.status !== status
    )
      return yield* RepositoryError.make({ message: `Steering admission ${value.request_id} is inconsistent` })
    return admission
  })

const encodeAdmission = (admission: SteeringAdmission) => Schema.encodeEffect(turnRowJson.steeringAdmission)(admission)

const sameAdmission = (
  admission: SteeringAdmission,
  target: ExecutionLink,
  input: SteeringInput,
  source: TurnId | undefined,
) =>
  equivalentTarget(admission.target, target) &&
  equivalentInput(admission.input, input) &&
  (admission.source?.id ?? undefined) === source

const validateTarget = (sql: SqlClient, target: ExecutionLink) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT * FROM rika_turns
      WHERE id = ${target.turnId} AND turn_kind = 'AgentExecution'
        AND status IN ('accepted', 'running', 'waiting', 'cancelling')`
    if (rows[0] === undefined)
      return yield* RepositoryError.make({ message: `Steering target ${target.turnId} is not active` })
    const turn = yield* decodeAgent(rows[0])
    if (turn.executionLink === undefined || !equivalentTarget(turn.executionLink, target))
      return yield* RepositoryError.make({ message: `Steering target ${target.turnId} has changed` })
    return turn
  })

const validateCapacity = (sql: SqlClient, target: ExecutionLink, pendingRequestIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const rows = yield* sql`SELECT request_id FROM rika_turn_steering_outbox
      WHERE target_turn_id = ${target.turnId} AND status <> 'rejected'`
    const requests = new Set(pendingRequestIds)
    for (const row of rows) requests.add(String((row as { readonly request_id: unknown }).request_id))
    if (requests.size >= PendingSteeringMaxEntries)
      return yield* RepositoryError.make({
        message: `Turn ${target.turnId} already has the maximum number of pending steering requests`,
      })
  })

const insertAdmission = (sql: SqlClient, admission: SteeringAdmission) =>
  Effect.gen(function* () {
    const encoded = yield* encodeAdmission(admission)
    yield* sql`INSERT INTO rika_turn_steering_outbox
      (request_id, target_turn_id, source_turn_id, thread_id, admission_json, source_withdrawn, status, prepared_at)
      VALUES (${admission.input.idempotencyKey}, ${admission.target.turnId}, ${admission.source?.id ?? null},
        ${admission.target.threadId}, ${encoded}, ${Number(admission.sourceWithdrawn === true)}, 'pending', ${admission.preparedAt})`
  })

const preserveQueuedUnavailable = (error: unknown) =>
  Schema.is(QueuedTurnUnavailable)(error) ? error : repositoryError(error)

export const makeTurnSqliteSteeringAdmission = (
  sql: SqlClient,
): Pick<
  Interface,
  | "prepareSteeringAdmission"
  | "prepareQueuedSteeringAdmission"
  | "listSteeringAdmissions"
  | "acceptSteeringAdmission"
  | "rejectSteeringAdmission"
  | "completeSteeringAdmission"
  | "completeRejectedSteeringAdmission"
> => ({
  prepareSteeringAdmission: Effect.fn("TurnRepository.prepareSteeringAdmission")(
    function* (target, input, pendingRequestIds, now) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existingRows =
              yield* sql`SELECT * FROM rika_turn_steering_outbox WHERE request_id = ${input.idempotencyKey}`
            if (existingRows[0] !== undefined) {
              const existing = yield* decodeAdmission(existingRows[0])
              if (!sameAdmission(existing, target, input, undefined))
                return yield* RepositoryError.make({ message: `Steering request ${input.idempotencyKey} conflicts` })
              return existing
            }
            yield* validateTarget(sql, target)
            yield* validateCapacity(sql, target, pendingRequestIds)
            const admission: SteeringAdmission = {
              target,
              input,
              preparedAt: now,
              outcome: { _tag: "Pending" },
            }
            yield* insertAdmission(sql, admission)
            return admission
          }),
        )
        .pipe(Effect.mapError(repositoryError))
    },
  ),
  prepareQueuedSteeringAdmission: Effect.fn("TurnRepository.prepareQueuedSteeringAdmission")(
    function* (source, target, input, pendingRequestIds, now) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const existingRows = yield* sql`SELECT * FROM rika_turn_steering_outbox
            WHERE request_id = ${input.idempotencyKey} OR source_turn_id = ${source}`
            if (existingRows.length > 0) {
              const admissions = yield* Effect.all(existingRows.map(decodeAdmission))
              const existing = admissions[0]!
              if (admissions.length !== 1 || !sameAdmission(existing, target, input, source))
                return yield* RepositoryError.make({
                  message: `Queued turn ${source} already has a different steering admission`,
                })
              const queueRows =
                yield* sql`SELECT * FROM rika_thread_queue_state WHERE thread_id = ${existing.source!.threadId}`
              const queue = queueRows[0] === undefined ? undefined : yield* decodeQueueState(queueRows[0])
              return {
                admission: existing,
                queueChanged: false,
                queue:
                  existing.outcome._tag === "Rejected" && existing.outcome.queue !== undefined
                    ? existing.outcome.queue
                    : {
                        threadId: existing.source!.threadId,
                        revision: queue?.revision ?? 0,
                        queuedCount: queue?.queued_count ?? 0,
                        becameNonempty: false,
                        change: { _tag: "Removed" as const, turnId: existing.source!.id },
                      },
              }
            }
            const targetTurn = yield* validateTarget(sql, target)
            const rows = yield* sql`SELECT * FROM rika_turns
            WHERE id = ${source} AND turn_kind = 'AgentExecution' AND status = 'queued'`
            if (rows[0] === undefined) return yield* queuedTurnUnavailable(source)
            const sourceTurn = yield* decodeAgent(rows[0])
            if (sourceTurn.threadId !== targetTurn.threadId)
              return yield* RepositoryError.make({
                message: `Queued turn ${source} does not belong to target ${target.turnId}`,
              })
            yield* validateCapacity(sql, target, pendingRequestIds)
            const admission: SteeringAdmission = {
              target,
              input,
              source: sourceTurn,
              sourceWithdrawn: true,
              preparedAt: now,
              outcome: { _tag: "Pending" },
            }
            yield* insertAdmission(sql, admission)
            yield* sql`UPDATE rika_turns SET queue_claim_token = NULL WHERE id = ${sourceTurn.id}`
            const queueRows = yield* sql`UPDATE rika_thread_queue_state
            SET revision = revision + 1,
              queued_count = CASE WHEN queued_count > 0 THEN queued_count - 1 ELSE 0 END
            WHERE thread_id = ${sourceTurn.threadId} RETURNING *`
            if (queueRows[0] === undefined)
              return yield* RepositoryError.make({ message: `Queue state ${sourceTurn.threadId} does not exist` })
            const queue = yield* decodeQueueState(queueRows[0])
            return {
              admission,
              queue: {
                threadId: sourceTurn.threadId,
                revision: queue.revision,
                queuedCount: queue.queued_count,
                becameNonempty: false,
                change: { _tag: "Removed" as const, turnId: sourceTurn.id },
              },
              queueChanged: true,
            }
          }),
        )
        .pipe(Effect.mapError(preserveQueuedUnavailable))
    },
  ),
  listSteeringAdmissions: Effect.gen(function* () {
    const rows = yield* sql`SELECT * FROM rika_turn_steering_outbox
      ORDER BY prepared_at ASC, request_id ASC`
    return yield* Effect.all(rows.map(decodeAdmission))
  }).pipe(Effect.mapError(repositoryError)),
  acceptSteeringAdmission: Effect.fn("TurnRepository.acceptSteeringAdmission")(function* (requestId, receipt) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`SELECT * FROM rika_turn_steering_outbox WHERE request_id = ${requestId}`
          if (rows[0] === undefined)
            return yield* RepositoryError.make({ message: `Steering admission ${requestId} does not exist` })
          const admission = yield* decodeAdmission(rows[0])
          if (admission.outcome._tag === "Rejected")
            return yield* RepositoryError.make({ message: `Steering admission ${requestId} was rejected` })
          if (admission.outcome._tag === "Accepted") {
            if (!equivalentReceipt(admission.outcome.receipt, receipt))
              return yield* RepositoryError.make({ message: `Steering admission ${requestId} receipt conflicts` })
            return admission
          }
          const accepted: SteeringAdmission = { ...admission, outcome: { _tag: "Accepted", receipt } }
          const encoded = yield* encodeAdmission(accepted)
          yield* sql`UPDATE rika_turn_steering_outbox
            SET admission_json = ${encoded}, status = 'accepted' WHERE request_id = ${requestId}`
          return accepted
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  rejectSteeringAdmission: Effect.fn("TurnRepository.rejectSteeringAdmission")(function* (requestId, failure) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql`SELECT * FROM rika_turn_steering_outbox WHERE request_id = ${requestId}`
          if (rows[0] === undefined)
            return yield* RepositoryError.make({ message: `Steering admission ${requestId} does not exist` })
          const admission = yield* decodeAdmission(rows[0])
          if (admission.outcome._tag === "Accepted")
            return yield* RepositoryError.make({ message: `Steering admission ${requestId} was accepted` })
          if (admission.outcome._tag === "Rejected") {
            if (!equivalentFailure(admission.outcome.failure, failure))
              return yield* RepositoryError.make({ message: `Steering admission ${requestId} rejection conflicts` })
            return admission
          }
          let queue: Effect.Success<ReturnType<Interface["dequeue"]>> | undefined
          if (admission.source !== undefined) {
            const existingRows = yield* sql`SELECT * FROM rika_turns WHERE id = ${admission.source.id}`
            if (existingRows[0] !== undefined) {
              const existing = yield* decodeAgent(existingRows[0])
              if (existing.status === "queued") {
                const visibleRows = yield* sql`SELECT id FROM rika_turns
                  WHERE thread_id = ${admission.source.threadId} AND turn_kind = 'AgentExecution' AND status = 'queued'
                    AND (
                      id = ${admission.source.id} OR NOT EXISTS (
                        SELECT 1 FROM rika_turn_steering_outbox
                        WHERE source_turn_id = rika_turns.id AND status != 'rejected'
                      )
                    )
                  ORDER BY created_at ASC, id ASC`
                const position = visibleRows.findIndex(
                  (row) => String((row as { readonly id: unknown }).id) === admission.source!.id,
                )
                const queueRows = yield* sql`UPDATE rika_thread_queue_state
                  SET revision = revision + 1,
                    queued_count = queued_count + ${admission.sourceWithdrawn === true ? 1 : 0}
                  WHERE thread_id = ${admission.source.threadId} RETURNING *`
                if (queueRows[0] === undefined)
                  return yield* RepositoryError.make({
                    message: `Queue state ${admission.source.threadId} does not exist`,
                  })
                const state = yield* decodeQueueState(queueRows[0])
                queue = {
                  threadId: admission.source.threadId,
                  revision: state.revision,
                  queuedCount: state.queued_count,
                  becameNonempty: admission.sourceWithdrawn === true && state.queued_count === 1,
                  change:
                    admission.sourceWithdrawn === true
                      ? { _tag: "Added" as const, turn: existing, position }
                      : { _tag: "Updated" as const, turn: existing },
                }
              }
            }
          }
          const rejected: SteeringAdmission = {
            ...admission,
            outcome: { _tag: "Rejected", failure, ...(queue === undefined ? {} : { queue }) },
          }
          const encoded = yield* encodeAdmission(rejected)
          yield* sql`UPDATE rika_turn_steering_outbox
            SET admission_json = ${encoded}, status = 'rejected' WHERE request_id = ${requestId}`
          return rejected
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  completeSteeringAdmission: Effect.fn("TurnRepository.completeSteeringAdmission")(
    function* (requestId, target, receipt) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`SELECT * FROM rika_turn_steering_outbox WHERE request_id = ${requestId}`
            if (rows[0] === undefined) return undefined
            const admission = yield* decodeAdmission(rows[0])
            if (
              admission.outcome._tag !== "Accepted" ||
              !equivalentTarget(admission.target, target) ||
              !equivalentReceipt(admission.outcome.receipt, receipt)
            )
              return yield* RepositoryError.make({
                message: `Steering admission ${requestId} disposition conflicts`,
              })
            yield* sql`DELETE FROM rika_turn_steering_outbox WHERE request_id = ${requestId}`
            if (admission.source === undefined) return undefined
            const queued = yield* sql`SELECT id FROM rika_turns
            WHERE id = ${admission.source.id} AND turn_kind = 'AgentExecution' AND status = 'queued'`
            if (queued[0] === undefined) return undefined
            yield* sql`DELETE FROM rika_turns
            WHERE id = ${admission.source.id} AND turn_kind = 'AgentExecution' AND status = 'queued'`
            if (admission.sourceWithdrawn === true) return undefined
            const queueRows = yield* sql`UPDATE rika_thread_queue_state
              SET revision = revision + 1,
                queued_count = CASE WHEN queued_count > 0 THEN queued_count - 1 ELSE 0 END
              WHERE thread_id = ${admission.source.threadId} RETURNING *`
            if (queueRows[0] === undefined)
              return yield* RepositoryError.make({ message: `Queue state ${admission.source.threadId} does not exist` })
            const state = yield* decodeQueueState(queueRows[0])
            return {
              threadId: admission.source.threadId,
              revision: state.revision,
              queuedCount: state.queued_count,
              becameNonempty: false,
              change: { _tag: "Removed" as const, turnId: admission.source.id },
            }
          }),
        )
        .pipe(Effect.mapError(repositoryError))
    },
  ),
  completeRejectedSteeringAdmission: Effect.fn("TurnRepository.completeRejectedSteeringAdmission")(
    function* (requestId) {
      return yield* Effect.gen(function* () {
        const deleted = yield* sql`DELETE FROM rika_turn_steering_outbox
        WHERE request_id = ${requestId} AND status = 'rejected'
        RETURNING request_id`
        if (deleted[0] !== undefined) return true
        const rows = yield* sql`SELECT * FROM rika_turn_steering_outbox WHERE request_id = ${requestId}`
        if (rows[0] === undefined) return true
        const admission = yield* decodeAdmission(rows[0])
        if (admission.outcome._tag !== "Rejected")
          return yield* RepositoryError.make({ message: `Steering admission ${requestId} was not rejected` })
        return false
      }).pipe(Effect.mapError(repositoryError))
    },
  ),
})
