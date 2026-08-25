import * as PgClient from "@effect/sql-pg/PgClient"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import * as ExecutionStatus from "@rika/product/execution-status"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { PromptPart } from "@rika/product/execution-request"
import * as HostedObservability from "@rika/product/hosted-observability"
import { Context, Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

export class HostedTurnWorkerStoreError extends Schema.TaggedError<HostedTurnWorkerStoreError>()(
  "HostedTurnWorkerStoreError",
  { message: Schema.String },
) {}

export interface ClaimRequest {
  readonly workerId: string
  readonly claimToken: string
  readonly leaseMillis: number
}

export interface TurnClaim {
  readonly workerId: string
  readonly claimToken: string
  readonly expiresAt: number
  readonly preparedExecution?: ExecutionGateway.PreparedTurn
  readonly admissionLink?: ExecutionGateway.ExecutionLink
  readonly activationRequested: boolean
  readonly ownerId: string
  readonly claimedAt: number
  readonly input: ExecutionGateway.StartTurn
}

export interface HostedTurnWorkerStoreService {
  readonly claimNext: (request: ClaimRequest) => Effect.Effect<TurnClaim | undefined, HostedTurnWorkerStoreError>
  readonly claimRecovery: (request: ClaimRequest) => Effect.Effect<TurnClaim | undefined, HostedTurnWorkerStoreError>
  readonly renew: (
    claim: TurnClaim,
    leaseMillis: number,
  ) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
  readonly prepare: (
    claim: TurnClaim,
    prepared: ExecutionGateway.PreparedTurn,
    now: number,
  ) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
  readonly completeAdmission: (
    claim: TurnClaim,
    link: ExecutionGateway.ExecutionLink,
    now: number,
  ) => Effect.Effect<void, HostedTurnWorkerStoreError>
  readonly requestActivation: (claim: TurnClaim, now: number) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
  readonly completeActivation: (
    claim: TurnClaim,
    status: ExecutionStatus.ActivationStatus,
    now: number,
  ) => Effect.Effect<void, HostedTurnWorkerStoreError>
  readonly release: (claim: TurnClaim) => Effect.Effect<void, HostedTurnWorkerStoreError>
}

export class HostedTurnWorkerStore extends Context.Service<HostedTurnWorkerStore, HostedTurnWorkerStoreService>()(
  "@rika/product-store/hosted/postgres-turn-worker-store/HostedTurnWorkerStore",
) {}

const failure = (cause: unknown) =>
  HostedTurnWorkerStoreError.make({ message: `Hosted Turn worker store failed: ${String(cause)}` })
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(failure))
const transaction = <A>(sql: SqlClient, effect: Effect.Effect<A, HostedTurnWorkerStoreError>) =>
  sql.withTransaction(effect).pipe(Effect.catchTag("SqlError", failure))
const ExecutionRouteJson = Schema.fromJsonString(ExecutionRouteSnapshot)
const PromptPartsJson = Schema.fromJsonString(Schema.Array(PromptPart))
const StartTurnJson = Schema.fromJsonString(ExecutionGateway.StartTurn)
const PreparedTurnJson = Schema.fromJsonString(ExecutionGateway.PreparedTurn)
const ExecutionLinkJson = Schema.fromJsonString(ExecutionGateway.ExecutionLink)

interface TurnRow {
  readonly ownerId: string
  readonly threadId: string
  readonly turnId: string
  readonly status: "accepted" | "queued"
  readonly workspaceId: string
  readonly prompt: string
  readonly promptPartsJson: string | null
  readonly executionRouteJson: string
  readonly queuedAt: string
  readonly preparedTurnJson: string | null
  readonly admissionLinkJson: string | null
  readonly activationRequestedAt: string | null
}

const decodeInput = (row: TurnRow) =>
  Effect.gen(function* () {
    const executionRoute = yield* Schema.decodeUnknownEffect(ExecutionRouteJson)(row.executionRouteJson)
    const promptParts =
      row.promptPartsJson === null ? undefined : yield* Schema.decodeUnknownEffect(PromptPartsJson)(row.promptPartsJson)
    return yield* Schema.decodeUnknownEffect(ExecutionGateway.StartTurn)({
      threadId: row.threadId,
      turnId: row.turnId,
      workspaceId: row.workspaceId,
      prompt: row.prompt,
      executionRoute,
      ...(promptParts === undefined ? {} : { promptParts }),
    })
  }).pipe(Effect.mapError(failure))

const claim = (
  sql: SqlClient,
  request: ClaimRequest,
  source: Effect.Effect<ReadonlyArray<TurnRow>, HostedTurnWorkerStoreError>,
) =>
  transaction(
    sql,
    Effect.gen(function* () {
      const row = (yield* source)[0]
      if (row === undefined) return undefined
      const queuedAt = Number(row.queuedAt)
      if (!Number.isFinite(queuedAt)) return yield* failure("Turn queue timestamp is invalid")
      const databaseNow = sql`floor(extract(epoch from transaction_timestamp()) * 1000)::bigint`
      yield* query(sql`DELETE FROM rika_hosted_turn_claims
            WHERE thread_id = ${row.threadId} AND expires_at <= ${databaseNow}`)
      const claims = yield* query(sql<{ readonly claimedAt: string; readonly expiresAt: string }>`INSERT INTO rika_hosted_turn_claims
            (turn_id, owner_id, thread_id, worker_id, claim_token, claimed_at, heartbeat_at, expires_at)
            VALUES (${row.turnId}, ${row.ownerId}, ${row.threadId}, ${request.workerId}, ${request.claimToken},
              ${databaseNow}, ${databaseNow}, ${databaseNow} + ${request.leaseMillis})
            ON CONFLICT DO NOTHING RETURNING claimed_at::text AS "claimedAt", expires_at::text AS "expiresAt"`)
      const claimed = claims[0]
      if (claimed === undefined) return undefined
      const claimedAt = Number(claimed.claimedAt)
      const expiresAt = Number(claimed.expiresAt)
      if (!Number.isFinite(claimedAt) || !Number.isFinite(expiresAt))
        return yield* failure("Turn claim timestamp is invalid")
      const preparedExecution =
        row.preparedTurnJson === null
          ? undefined
          : yield* Schema.decodeUnknownEffect(PreparedTurnJson)(row.preparedTurnJson).pipe(Effect.mapError(failure))
      const admissionLink =
        row.admissionLinkJson === null
          ? undefined
          : yield* Schema.decodeUnknownEffect(ExecutionLinkJson)(row.admissionLinkJson).pipe(Effect.mapError(failure))
      return {
        workerId: request.workerId,
        claimToken: request.claimToken,
        expiresAt,
        ...(preparedExecution === undefined ? {} : { preparedExecution }),
        ...(admissionLink === undefined ? {} : { admissionLink }),
        activationRequested: row.activationRequestedAt !== null,
        ownerId: row.ownerId,
        claimedAt,
        input: yield* decodeInput(row),
        queueWaitMillis: claimedAt - queuedAt,
      }
    }),
  ).pipe(
    Effect.tap((turnClaim) =>
      turnClaim === undefined
        ? Effect.void
        : HostedObservability.event("turn_claim", "success", {
            threadId: turnClaim.input.threadId,
            turnId: turnClaim.input.turnId,
          }).pipe(
            Effect.andThen(
              HostedObservability.queueWaitObserved(
                { threadId: turnClaim.input.threadId, turnId: turnClaim.input.turnId },
                turnClaim.queueWaitMillis,
              ),
            ),
          ),
    ),
    Effect.map((turnClaim) => {
      if (turnClaim === undefined) return undefined
      const { queueWaitMillis: _, ...claimedTurn } = turnClaim
      return claimedTurn
    }),
  )

export const layer = Layer.effect(
  HostedTurnWorkerStore,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient
    const claimNext: HostedTurnWorkerStoreService["claimNext"] = (request) =>
      claim(
        sql,
        request,
        query(sql<TurnRow>`SELECT thread_record.owner_id AS "ownerId", turn_record.thread_id AS "threadId",
          turn_record.id AS "turnId", turn_record.status, hosted_thread.workspace_id AS "workspaceId", turn_record.prompt,
          turn_record.prompt_parts_json AS "promptPartsJson", turn_record.execution_route_json AS "executionRouteJson",
          turn_record.created_at::text AS "queuedAt", NULL::text AS "preparedTurnJson",
          NULL::text AS "admissionLinkJson", NULL::text AS "activationRequestedAt"
        FROM rika_turns turn_record
        JOIN rika_threads thread_record ON thread_record.id = turn_record.thread_id
        JOIN rika_hosted_threads hosted_thread ON hosted_thread.id = turn_record.thread_id
          AND hosted_thread.owner_id = thread_record.owner_id
        WHERE turn_record.turn_kind = 'AgentExecution' AND turn_record.status IN ('accepted', 'queued')
          AND NOT EXISTS (
            SELECT 1 FROM rika_hosted_turn_claims active_claim
            JOIN rika_turns active_turn ON active_turn.id = active_claim.turn_id
            WHERE active_turn.thread_id = turn_record.thread_id
              AND active_claim.expires_at > floor(extract(epoch from transaction_timestamp()) * 1000)
          )
          AND NOT EXISTS (
            SELECT 1 FROM rika_turns active_turn
            WHERE active_turn.thread_id = turn_record.thread_id AND active_turn.turn_kind = 'AgentExecution'
              AND active_turn.id <> turn_record.id
              AND active_turn.status IN ('accepted', 'running', 'waiting', 'cancelling')
          )
        ORDER BY CASE turn_record.status WHEN 'accepted' THEN 0 ELSE 1 END, turn_record.created_at, turn_record.id
        FOR UPDATE OF turn_record SKIP LOCKED LIMIT 1`),
      )
    const claimRecovery: HostedTurnWorkerStoreService["claimRecovery"] = (request) =>
      claim(
        sql,
        request,
        query(sql<TurnRow>`SELECT thread_record.owner_id AS "ownerId", turn_record.thread_id AS "threadId",
          turn_record.id AS "turnId", 'accepted' AS status, hosted_thread.workspace_id AS "workspaceId", turn_record.prompt,
          turn_record.prompt_parts_json AS "promptPartsJson", turn_record.execution_route_json AS "executionRouteJson",
          admission.prepared_at::text AS "queuedAt", admission.prepared_turn_json AS "preparedTurnJson",
          admission.admission_link_json AS "admissionLinkJson",
          admission.activation_requested_at::text AS "activationRequestedAt"
        FROM rika_turn_admission_outbox admission
        JOIN rika_turns turn_record ON turn_record.id = admission.turn_id
        JOIN rika_threads thread_record ON thread_record.id = turn_record.thread_id
        JOIN rika_hosted_threads hosted_thread ON hosted_thread.id = turn_record.thread_id
          AND hosted_thread.owner_id = thread_record.owner_id
        WHERE turn_record.turn_kind = 'AgentExecution'
          AND turn_record.status IN ('accepted', 'running', 'cancelling', 'cancelled')
          AND admission.prepared_turn_json IS NOT NULL
          AND (turn_record.status = 'cancelled' OR hosted_thread.executor_kind = 'runner' OR EXISTS (
            SELECT 1 FROM rika_hosted_executor_assignments assignment
            JOIN rika_hosted_workspace_preparations preparation
              ON preparation.assignment_id = assignment.id
              AND preparation.generation = assignment.generation
              AND preparation.lease_epoch = assignment.lease_epoch
              AND preparation.state = 'ready'
            WHERE assignment.thread_id = hosted_thread.id AND assignment.lifecycle = 'active'
              AND assignment.lease_expires_at > clock_timestamp()
          ))
          AND NOT EXISTS (
            SELECT 1 FROM rika_hosted_turn_claims active_claim
            WHERE active_claim.turn_id = turn_record.id
              AND active_claim.expires_at > floor(extract(epoch from transaction_timestamp()) * 1000)
          )
        ORDER BY admission.prepared_at, admission.turn_id
        FOR UPDATE OF turn_record SKIP LOCKED LIMIT 1`),
      )
    const renew: HostedTurnWorkerStoreService["renew"] = Effect.fn("HostedTurnWorkerStore.renew")(
      function* (turnClaim, leaseMillis) {
        const databaseNow = sql`floor(extract(epoch from transaction_timestamp()) * 1000)::bigint`
        const renewed = yield* query(sql`UPDATE rika_hosted_turn_claims
          SET heartbeat_at = ${databaseNow}, expires_at = ${databaseNow} + ${leaseMillis}
          WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
            AND claim_token = ${turnClaim.claimToken} AND expires_at > ${databaseNow}
          RETURNING turn_id`)
        return renewed[0] !== undefined
      },
    )
    const prepare: HostedTurnWorkerStoreService["prepare"] = Effect.fn("HostedTurnWorkerStore.prepare")(
      function* (turnClaim, prepared, now) {
        if (prepared.turnId !== turnClaim.input.turnId || prepared.threadId !== turnClaim.input.threadId)
          return yield* failure("Prepared execution does not identify the claimed Turn")
        const encodedInput = yield* Schema.encodeEffect(StartTurnJson)(turnClaim.input).pipe(Effect.mapError(failure))
        const encodedPrepared = yield* Schema.encodeEffect(PreparedTurnJson)(prepared).pipe(Effect.mapError(failure))
        return yield* transaction(
          sql,
          Effect.gen(function* () {
            const authority = yield* query(sql`SELECT 1 FROM rika_hosted_turn_claims
              WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
                AND claim_token = ${turnClaim.claimToken}
                AND expires_at > floor(extract(epoch from transaction_timestamp()) * 1000) FOR UPDATE`)
            if (authority[0] === undefined) return false
            const lane = yield* query(sql<{ readonly status: "accepted" | "queued" }>`SELECT status FROM rika_turns
              WHERE id = ${turnClaim.input.turnId} AND thread_id = ${turnClaim.input.threadId}
                AND turn_kind = 'AgentExecution' AND status IN ('accepted', 'queued') FOR UPDATE`)
            if (lane[0] === undefined) return false
            const transitioned = yield* query(sql`UPDATE rika_turns
              SET status = 'accepted', updated_at = ${now}, queue_claim_token = NULL
              WHERE id = ${turnClaim.input.turnId} AND thread_id = ${turnClaim.input.threadId}
                AND turn_kind = 'AgentExecution' AND status = ${lane[0].status} RETURNING thread_id`)
            if (transitioned[0] === undefined) return false
            if (lane[0].status === "queued") {
              const queue = yield* query(sql`UPDATE rika_thread_queue_state
                SET revision = revision + 1, queued_count = CASE WHEN queued_count > 0 THEN queued_count - 1 ELSE 0 END
                WHERE thread_id = ${turnClaim.input.threadId} RETURNING thread_id`)
              if (queue[0] === undefined) return yield* failure("Turn queue state is missing")
            }
            yield* query(sql`INSERT INTO rika_turn_admission_outbox
              (turn_id, start_input_json, prepared_turn_json, prepared_at)
              VALUES (${turnClaim.input.turnId}, ${encodedInput}, ${encodedPrepared}, ${now})
              ON CONFLICT (turn_id) DO NOTHING`)
            const persistedRows = yield* query(sql<{
              readonly startInputJson: string
              readonly preparedTurnJson: string | null
            }>`SELECT start_input_json AS "startInputJson", prepared_turn_json AS "preparedTurnJson"
              FROM rika_turn_admission_outbox WHERE turn_id = ${turnClaim.input.turnId}`)
            const persisted = persistedRows[0]
            if (persisted?.preparedTurnJson === null || persisted === undefined)
              return yield* failure("Turn has an incomplete legacy execution admission")
            const persistedInput = yield* Schema.decodeUnknownEffect(StartTurnJson)(persisted.startInputJson).pipe(
              Effect.mapError(failure),
            )
            const persistedPrepared = yield* Schema.decodeUnknownEffect(PreparedTurnJson)(
              persisted.preparedTurnJson,
            ).pipe(Effect.mapError(failure))
            if (!Schema.toEquivalence(ExecutionGateway.StartTurn)(persistedInput, turnClaim.input))
              return yield* failure("Turn already has a different start input")
            if (!Schema.toEquivalence(ExecutionGateway.PreparedTurn)(persistedPrepared, prepared))
              return yield* failure("Turn already has a different prepared execution")
            return true
          }),
        )
      },
    )
    const completeAdmission: HostedTurnWorkerStoreService["completeAdmission"] = Effect.fn(
      "HostedTurnWorkerStore.completeAdmission",
    )(function* (turnClaim, link, now) {
      if (link.turnId !== turnClaim.input.turnId || link.threadId !== turnClaim.input.threadId)
        return yield* failure("Execution link does not identify the claimed Turn")
      const encoded = yield* Schema.encodeEffect(ExecutionLinkJson)(link).pipe(Effect.mapError(failure))
      yield* transaction(
        sql,
        Effect.gen(function* () {
          const authority = yield* query(sql`SELECT 1 FROM rika_hosted_turn_claims
              WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
                AND claim_token = ${turnClaim.claimToken}
                AND expires_at > floor(extract(epoch from transaction_timestamp()) * 1000) FOR UPDATE`)
          if (authority[0] === undefined) return yield* failure("Turn claim is no longer owned by this worker")
          const rows = yield* query(sql<{ readonly admissionLinkJson: string | null }>`SELECT
              admission_link_json AS "admissionLinkJson" FROM rika_turn_admission_outbox
              WHERE turn_id = ${turnClaim.input.turnId} FOR UPDATE`)
          const existing = rows[0]
          if (existing === undefined) return yield* failure("Claimed Turn has no prepared execution")
          if (existing.admissionLinkJson !== null) {
            const persisted = yield* Schema.decodeUnknownEffect(ExecutionLinkJson)(existing.admissionLinkJson).pipe(
              Effect.mapError(failure),
            )
            if (!Schema.toEquivalence(ExecutionGateway.ExecutionLink)(persisted, link))
              return yield* failure("Claimed Turn already has a different admission link")
          } else {
            yield* query(sql`UPDATE rika_turn_admission_outbox
                SET admission_link_json = ${encoded}, admitted_at = ${now}
                WHERE turn_id = ${turnClaim.input.turnId}`)
          }
        }),
      )
    })
    const requestActivation: HostedTurnWorkerStoreService["requestActivation"] = Effect.fn(
      "HostedTurnWorkerStore.requestActivation",
    )(function* (turnClaim, now) {
      return yield* transaction(
        sql,
        Effect.gen(function* () {
          const authority = yield* query(sql`SELECT 1 FROM rika_hosted_turn_claims
            WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
              AND claim_token = ${turnClaim.claimToken}
              AND expires_at > floor(extract(epoch from transaction_timestamp()) * 1000) FOR UPDATE`)
          if (authority[0] === undefined) return yield* failure("Turn claim is no longer owned by this worker")
          const admissions = yield* query(sql<{
            readonly linkJson: string | null
            readonly activationRequestedAt: number | null
          }>`SELECT admission_link_json AS "linkJson", activation_requested_at AS "activationRequestedAt"
            FROM rika_turn_admission_outbox WHERE turn_id = ${turnClaim.input.turnId} FOR UPDATE`)
          const admission = admissions[0]
          if (admission?.linkJson === null || admission === undefined)
            return yield* failure("Turn has no staged Runtime admission")
          const turns = yield* query(sql<{
            readonly status: string
            readonly executionLinkJson: string | null
          }>`SELECT status, execution_link_json AS "executionLinkJson" FROM rika_turns
            WHERE id = ${turnClaim.input.turnId} AND thread_id = ${turnClaim.input.threadId} FOR UPDATE`)
          const turn = turns[0]
          if (turn === undefined) return yield* failure("Claimed Turn does not exist")
          if (turn.status !== "accepted" && turn.status !== "running") return false
          if (admission.activationRequestedAt !== null) {
            if (turn.executionLinkJson !== admission.linkJson)
              return yield* failure("Activated Turn execution link does not match its staged admission")
            return true
          }
          if (turn.status !== "accepted") return yield* failure("Running Turn has no durable activation request")
          const activated = yield* query(sql`UPDATE rika_turns
            SET execution_link_json = ${admission.linkJson}, updated_at = ${now}
            WHERE id = ${turnClaim.input.turnId} AND status = 'accepted' RETURNING id`)
          if (activated[0] === undefined) return false
          yield* query(sql`UPDATE rika_turn_admission_outbox SET activation_requested_at = ${now}
            WHERE turn_id = ${turnClaim.input.turnId}`)
          return true
        }),
      )
    })
    const completeActivation: HostedTurnWorkerStoreService["completeActivation"] = Effect.fn(
      "HostedTurnWorkerStore.completeActivation",
    )(function* (turnClaim, status, now) {
      yield* transaction(
        sql,
        Effect.gen(function* () {
          const authority = yield* query(sql`SELECT 1 FROM rika_hosted_turn_claims
            WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
              AND claim_token = ${turnClaim.claimToken}
              AND expires_at > floor(extract(epoch from transaction_timestamp()) * 1000) FOR UPDATE`)
          if (authority[0] === undefined) return yield* failure("Turn claim is no longer owned by this worker")
          yield* query(sql`UPDATE rika_turns SET status = ${status}, updated_at = ${now}
            WHERE id = ${turnClaim.input.turnId} AND status = 'accepted'`)
          yield* query(sql`DELETE FROM rika_turn_admission_outbox WHERE turn_id = ${turnClaim.input.turnId}`)
          yield* query(sql`DELETE FROM rika_hosted_turn_claims
            WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
              AND claim_token = ${turnClaim.claimToken}`)
        }),
      )
    })
    const release: HostedTurnWorkerStoreService["release"] = Effect.fn("HostedTurnWorkerStore.release")(
      function* (turnClaim) {
        yield* query(sql`DELETE FROM rika_hosted_turn_claims
          WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
            AND claim_token = ${turnClaim.claimToken}
            AND EXISTS (SELECT 1 FROM rika_turns WHERE id = ${turnClaim.input.turnId}
              AND status IN ('accepted', 'queued'))`).pipe(Effect.asVoid)
      },
    )
    return HostedTurnWorkerStore.of({
      claimNext,
      claimRecovery,
      renew,
      prepare,
      completeAdmission,
      requestActivation,
      completeActivation,
      release,
    })
  }),
)
