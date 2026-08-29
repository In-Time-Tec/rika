import { and, asc, eq, inArray, ne, notExists, or, sql as expression } from "drizzle-orm"
import type * as PgDrizzle from "drizzle-orm/effect-postgres"
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
import { rikaThreadQueueState, rikaTurnSteeringOutbox, rikaTurns } from "../../database/schema/product"
import { decodeAgent, decodeQueueState } from "./row-codec"
import { turnRowSelection } from "./reader"
import { turnRowJson } from "./row-json-codec"
import { queuedTurnUnavailable, repositoryError } from "./errors"

const admissionSelection = {
  request_id: rikaTurnSteeringOutbox.requestId,
  target_turn_id: rikaTurnSteeringOutbox.targetTurnId,
  source_turn_id: rikaTurnSteeringOutbox.sourceTurnId,
  admission_json: rikaTurnSteeringOutbox.admissionJson,
  source_withdrawn: rikaTurnSteeringOutbox.sourceWithdrawn,
  status: rikaTurnSteeringOutbox.status,
}
const queueSelection = {
  thread_id: rikaThreadQueueState.threadId,
  revision: rikaThreadQueueState.revision,
  queued_count: rikaThreadQueueState.queuedCount,
}
const equivalentTarget = Schema.toEquivalence(ExecutionLink)
const equivalentInput = Schema.toEquivalence(SteeringInput)
const equivalentReceipt = Schema.toEquivalence(SteeringReceipt)
const equivalentFailure = Schema.toEquivalence(SteeringFailure)

type AdmissionRow = {
  request_id: string
  target_turn_id: string
  source_turn_id: string | null
  admission_json: string
  source_withdrawn: number
  status: string
}

const decodeAdmission = (value: AdmissionRow) =>
  Effect.gen(function* () {
    const admission = yield* Schema.decodeEffect(turnRowJson.steeringAdmission)(value.admission_json)
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

const validateTarget = (db: PgDrizzle.EffectPgDatabase, target: ExecutionLink) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select(turnRowSelection)
      .from(rikaTurns)
      .where(
        and(
          eq(rikaTurns.id, target.turnId),
          eq(rikaTurns.turnKind, "AgentExecution"),
          inArray(rikaTurns.status, ["accepted", "running", "waiting", "cancelling"]),
        ),
      )
      .limit(1)
    if (rows[0] === undefined)
      return yield* RepositoryError.make({ message: `Steering target ${target.turnId} is not active` })
    const turn = yield* decodeAgent(rows[0])
    if (turn.executionLink === undefined || !equivalentTarget(turn.executionLink, target))
      return yield* RepositoryError.make({ message: `Steering target ${target.turnId} has changed` })
    return turn
  })

const validateCapacity = (
  db: PgDrizzle.EffectPgDatabase,
  target: ExecutionLink,
  pendingRequestIds: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({ request_id: rikaTurnSteeringOutbox.requestId })
      .from(rikaTurnSteeringOutbox)
      .where(and(eq(rikaTurnSteeringOutbox.targetTurnId, target.turnId), ne(rikaTurnSteeringOutbox.status, "rejected")))
    const requests = new Set(pendingRequestIds)
    for (const row of rows) requests.add(row.request_id)
    if (requests.size >= PendingSteeringMaxEntries)
      return yield* RepositoryError.make({
        message: `Turn ${target.turnId} already has the maximum number of pending steering requests`,
      })
  })

const insertAdmission = (db: PgDrizzle.EffectPgDatabase, admission: SteeringAdmission) =>
  Effect.gen(function* () {
    const encoded = yield* encodeAdmission(admission)
    yield* db.insert(rikaTurnSteeringOutbox).values({
      requestId: admission.input.idempotencyKey,
      targetTurnId: admission.target.turnId,
      sourceTurnId: admission.source?.id ?? null,
      threadId: admission.target.threadId,
      admissionJson: encoded,
      sourceWithdrawn: Number(admission.sourceWithdrawn === true),
      status: "pending",
      preparedAt: admission.preparedAt,
    })
  })

const preserveQueuedUnavailable = <E>(error: E) =>
  Schema.is(QueuedTurnUnavailable)(error) ? error : repositoryError(error)

export const makeTurnSqlSteeringAdmission = (
  db: PgDrizzle.EffectPgDatabase,
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
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existingRows = yield* tx
              .select(admissionSelection)
              .from(rikaTurnSteeringOutbox)
              .where(eq(rikaTurnSteeringOutbox.requestId, input.idempotencyKey))
              .limit(1)
            if (existingRows[0] !== undefined) {
              const existing = yield* decodeAdmission(existingRows[0])
              if (!sameAdmission(existing, target, input, undefined))
                return yield* RepositoryError.make({ message: `Steering request ${input.idempotencyKey} conflicts` })
              return existing
            }
            yield* validateTarget(tx, target)
            yield* validateCapacity(tx, target, pendingRequestIds)
            const admission: SteeringAdmission = {
              target,
              input,
              preparedAt: now,
              outcome: { _tag: "Pending" },
            }
            yield* insertAdmission(tx, admission)
            return admission
          }),
        )
        .pipe(Effect.mapError(repositoryError))
    },
  ),
  prepareQueuedSteeringAdmission: Effect.fn("TurnRepository.prepareQueuedSteeringAdmission")(
    function* (source, target, input, pendingRequestIds, now) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const existingRows = yield* tx
              .select(admissionSelection)
              .from(rikaTurnSteeringOutbox)
              .where(
                or(
                  eq(rikaTurnSteeringOutbox.requestId, input.idempotencyKey),
                  eq(rikaTurnSteeringOutbox.sourceTurnId, source),
                ),
              )
            if (existingRows.length > 0) {
              const admissions = yield* Effect.all(existingRows.map(decodeAdmission))
              const existing = admissions[0]!
              if (admissions.length !== 1 || !sameAdmission(existing, target, input, source))
                return yield* RepositoryError.make({
                  message: `Queued turn ${source} already has a different steering admission`,
                })
              if (existing.source === undefined)
                return yield* RepositoryError.make({
                  message: `Steering admission ${existing.input.idempotencyKey} is inconsistent`,
                })
              const existingSource = existing.source
              const queueRows = yield* tx
                .select(queueSelection)
                .from(rikaThreadQueueState)
                .where(eq(rikaThreadQueueState.threadId, existingSource.threadId))
                .limit(1)
              const queue = queueRows[0] === undefined ? undefined : yield* decodeQueueState(queueRows[0])
              return {
                admission: existing,
                queueChanged: false,
                queue:
                  existing.outcome._tag === "Rejected" && existing.outcome.queue !== undefined
                    ? existing.outcome.queue
                    : {
                        threadId: existingSource.threadId,
                        revision: queue?.revision ?? 0,
                        queuedCount: queue?.queued_count ?? 0,
                        becameNonempty: false,
                        change: { _tag: "Removed" as const, turnId: existingSource.id },
                      },
              }
            }
            const targetTurn = yield* validateTarget(tx, target)
            const rows = yield* tx
              .select(turnRowSelection)
              .from(rikaTurns)
              .where(
                and(eq(rikaTurns.id, source), eq(rikaTurns.turnKind, "AgentExecution"), eq(rikaTurns.status, "queued")),
              )
              .limit(1)
            if (rows[0] === undefined) return yield* queuedTurnUnavailable(source)
            const sourceTurn = yield* decodeAgent(rows[0])
            if (sourceTurn.threadId !== targetTurn.threadId)
              return yield* RepositoryError.make({
                message: `Queued turn ${source} does not belong to target ${target.turnId}`,
              })
            yield* validateCapacity(tx, target, pendingRequestIds)
            const admission: SteeringAdmission = {
              target,
              input,
              source: sourceTurn,
              sourceWithdrawn: true,
              preparedAt: now,
              outcome: { _tag: "Pending" },
            }
            yield* insertAdmission(tx, admission)
            yield* tx.update(rikaTurns).set({ queueClaimToken: null }).where(eq(rikaTurns.id, sourceTurn.id))
            const queueRows = yield* tx
              .update(rikaThreadQueueState)
              .set({
                revision: expression`${rikaThreadQueueState.revision} + 1`,
                queuedCount: expression`CASE WHEN ${rikaThreadQueueState.queuedCount} > 0 THEN ${rikaThreadQueueState.queuedCount} - 1 ELSE 0 END`,
              })
              .where(eq(rikaThreadQueueState.threadId, sourceTurn.threadId))
              .returning(queueSelection)
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
    const rows = yield* db
      .select(admissionSelection)
      .from(rikaTurnSteeringOutbox)
      .orderBy(asc(rikaTurnSteeringOutbox.preparedAt), asc(rikaTurnSteeringOutbox.requestId))
    return yield* Effect.all(rows.map(decodeAdmission))
  }).pipe(Effect.mapError(repositoryError)),
  acceptSteeringAdmission: Effect.fn("TurnRepository.acceptSteeringAdmission")(function* (requestId, receipt) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx
            .select(admissionSelection)
            .from(rikaTurnSteeringOutbox)
            .where(eq(rikaTurnSteeringOutbox.requestId, requestId))
            .limit(1)
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
          yield* tx
            .update(rikaTurnSteeringOutbox)
            .set({ admissionJson: encoded, status: "accepted" })
            .where(eq(rikaTurnSteeringOutbox.requestId, requestId))
          return accepted
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  rejectSteeringAdmission: Effect.fn("TurnRepository.rejectSteeringAdmission")(function* (requestId, failure) {
    return yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx
            .select(admissionSelection)
            .from(rikaTurnSteeringOutbox)
            .where(eq(rikaTurnSteeringOutbox.requestId, requestId))
            .limit(1)
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
            const source = admission.source
            const existingRows = yield* tx
              .select(turnRowSelection)
              .from(rikaTurns)
              .where(eq(rikaTurns.id, source.id))
              .limit(1)
            if (existingRows[0] !== undefined) {
              const existing = yield* decodeAgent(existingRows[0])
              if (existing.status === "queued") {
                const hidden = tx
                  .select({ requestId: rikaTurnSteeringOutbox.requestId })
                  .from(rikaTurnSteeringOutbox)
                  .where(
                    and(
                      eq(rikaTurnSteeringOutbox.sourceTurnId, rikaTurns.id),
                      ne(rikaTurnSteeringOutbox.status, "rejected"),
                    ),
                  )
                const visibleRows = yield* tx
                  .select({ id: rikaTurns.id })
                  .from(rikaTurns)
                  .where(
                    and(
                      eq(rikaTurns.threadId, source.threadId),
                      eq(rikaTurns.turnKind, "AgentExecution"),
                      eq(rikaTurns.status, "queued"),
                      or(eq(rikaTurns.id, source.id), notExists(hidden)),
                    ),
                  )
                  .orderBy(asc(rikaTurns.createdAt), asc(rikaTurns.id))
                const position = visibleRows.findIndex((row) => row.id === source.id)
                const queueRows = yield* tx
                  .update(rikaThreadQueueState)
                  .set({
                    revision: expression`${rikaThreadQueueState.revision} + 1`,
                    queuedCount: expression`${rikaThreadQueueState.queuedCount} + ${admission.sourceWithdrawn === true ? 1 : 0}`,
                  })
                  .where(eq(rikaThreadQueueState.threadId, source.threadId))
                  .returning(queueSelection)
                if (queueRows[0] === undefined)
                  return yield* RepositoryError.make({
                    message: `Queue state ${source.threadId} does not exist`,
                  })
                const state = yield* decodeQueueState(queueRows[0])
                queue = {
                  threadId: source.threadId,
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
          const outcome: SteeringAdmission["outcome"] =
            queue === undefined ? { _tag: "Rejected", failure } : { _tag: "Rejected", failure, queue }
          const rejected: SteeringAdmission = {
            ...admission,
            outcome,
          }
          const encoded = yield* encodeAdmission(rejected)
          yield* tx
            .update(rikaTurnSteeringOutbox)
            .set({ admissionJson: encoded, status: "rejected" })
            .where(eq(rikaTurnSteeringOutbox.requestId, requestId))
          return rejected
        }),
      )
      .pipe(Effect.mapError(repositoryError))
  }),
  completeSteeringAdmission: Effect.fn("TurnRepository.completeSteeringAdmission")(
    function* (requestId, target, receipt) {
      return yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            const rows = yield* tx
              .select(admissionSelection)
              .from(rikaTurnSteeringOutbox)
              .where(eq(rikaTurnSteeringOutbox.requestId, requestId))
              .limit(1)
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
            yield* tx.delete(rikaTurnSteeringOutbox).where(eq(rikaTurnSteeringOutbox.requestId, requestId))
            if (admission.source === undefined) return undefined
            const queued = yield* tx
              .select({ id: rikaTurns.id })
              .from(rikaTurns)
              .where(
                and(
                  eq(rikaTurns.id, admission.source.id),
                  eq(rikaTurns.turnKind, "AgentExecution"),
                  eq(rikaTurns.status, "queued"),
                ),
              )
              .limit(1)
            if (queued[0] === undefined) return undefined
            yield* tx
              .delete(rikaTurns)
              .where(
                and(
                  eq(rikaTurns.id, admission.source.id),
                  eq(rikaTurns.turnKind, "AgentExecution"),
                  eq(rikaTurns.status, "queued"),
                ),
              )
            if (admission.sourceWithdrawn === true) return undefined
            const queueRows = yield* tx
              .update(rikaThreadQueueState)
              .set({
                revision: expression`${rikaThreadQueueState.revision} + 1`,
                queuedCount: expression`CASE WHEN ${rikaThreadQueueState.queuedCount} > 0 THEN ${rikaThreadQueueState.queuedCount} - 1 ELSE 0 END`,
              })
              .where(eq(rikaThreadQueueState.threadId, admission.source.threadId))
              .returning(queueSelection)
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
        const deleted = yield* db
          .delete(rikaTurnSteeringOutbox)
          .where(and(eq(rikaTurnSteeringOutbox.requestId, requestId), eq(rikaTurnSteeringOutbox.status, "rejected")))
          .returning({ requestId: rikaTurnSteeringOutbox.requestId })
        if (deleted[0] !== undefined) return true
        const rows = yield* db
          .select(admissionSelection)
          .from(rikaTurnSteeringOutbox)
          .where(eq(rikaTurnSteeringOutbox.requestId, requestId))
          .limit(1)
        if (rows[0] === undefined) return true
        const admission = yield* decodeAdmission(rows[0])
        if (admission.outcome._tag !== "Rejected")
          return yield* RepositoryError.make({ message: `Steering admission ${requestId} was not rejected` })
        return false
      }).pipe(Effect.mapError(repositoryError))
    },
  ),
})
