import * as PgClient from "@effect/sql-pg/PgClient"
import * as ExecutionGateway from "@rika/product/execution-gateway"
import { ExecutionRouteSnapshot } from "@rika/product/execution-route-snapshot"
import { PromptPart } from "@rika/product/execution-request"
import { Context, Effect, Layer, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

export class HostedTurnWorkerStoreError extends Schema.TaggedError<HostedTurnWorkerStoreError>()(
  "HostedTurnWorkerStoreError",
  { message: Schema.String },
) {}

export interface ClaimRequest {
  readonly workerId: string
  readonly claimToken: string
  readonly now: number
  readonly leaseMillis: number
}

export interface TurnClaim {
  readonly workerId: string
  readonly claimToken: string
  readonly expiresAt: number
  readonly prepared: boolean
  readonly input: ExecutionGateway.StartTurn
}

export interface HostedTurnWorkerStoreService {
  readonly claimNext: (request: ClaimRequest) => Effect.Effect<TurnClaim | undefined, HostedTurnWorkerStoreError>
  readonly claimRecovery: (request: ClaimRequest) => Effect.Effect<TurnClaim | undefined, HostedTurnWorkerStoreError>
  readonly prepare: (claim: TurnClaim, now: number) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
  readonly renew: (
    claim: TurnClaim,
    now: number,
    leaseMillis: number,
  ) => Effect.Effect<boolean, HostedTurnWorkerStoreError>
  readonly complete: (
    claim: TurnClaim,
    link: ExecutionGateway.ExecutionLink,
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
const ExecutionLinkJson = Schema.fromJsonString(ExecutionGateway.ExecutionLink)

interface TurnRow {
  readonly ownerId: string
  readonly threadId: string
  readonly turnId: string
  readonly workspaceId: string
  readonly prompt: string
  readonly promptPartsJson: string | null
  readonly executionRouteJson: string
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
  prepared: boolean,
) =>
  transaction(
    sql,
    Effect.gen(function* () {
      const row = (yield* source)[0]
      if (row === undefined) return undefined
      yield* query(sql`DELETE FROM rika_hosted_turn_claims
        WHERE thread_id = ${row.threadId} AND expires_at <= ${request.now}`)
      const claims = yield* query(sql`INSERT INTO rika_hosted_turn_claims
        (turn_id, owner_id, thread_id, worker_id, claim_token, claimed_at, heartbeat_at, expires_at)
        VALUES (${row.turnId}, ${row.ownerId}, ${row.threadId}, ${request.workerId}, ${request.claimToken},
          ${request.now}, ${request.now}, ${request.now + request.leaseMillis})
        ON CONFLICT DO NOTHING RETURNING turn_id`)
      const claimed = claims[0]
      if (claimed === undefined) return undefined
      return {
        workerId: request.workerId,
        claimToken: request.claimToken,
        expiresAt: request.now + request.leaseMillis,
        prepared,
        input: yield* decodeInput(row),
      }
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
          turn_record.id AS "turnId", hosted_thread.workspace_id AS "workspaceId", turn_record.prompt,
          turn_record.prompt_parts_json AS "promptPartsJson", turn_record.execution_route_json AS "executionRouteJson"
        FROM rika_turns turn_record
        JOIN rika_threads thread_record ON thread_record.id = turn_record.thread_id
        JOIN rika_hosted_threads hosted_thread ON hosted_thread.id = turn_record.thread_id
          AND hosted_thread.owner_id = thread_record.owner_id
        WHERE turn_record.turn_kind = 'AgentExecution' AND turn_record.status = 'queued'
          AND (hosted_thread.executor_kind = 'local_device' OR EXISTS (
            SELECT 1 FROM rika_hosted_executor_assignments assignment
            JOIN rika_hosted_workspace_preparations preparation
              ON preparation.assignment_id = assignment.id
              AND preparation.generation = assignment.generation
              AND preparation.lease_epoch = assignment.lease_epoch
              AND preparation.state = 'ready'
            WHERE assignment.id = hosted_thread.id AND assignment.lifecycle = 'active'
              AND assignment.lease_expires_at > clock_timestamp()
          ))
          AND NOT EXISTS (
            SELECT 1 FROM rika_hosted_turn_claims active_claim
            JOIN rika_turns active_turn ON active_turn.id = active_claim.turn_id
            WHERE active_turn.thread_id = turn_record.thread_id AND active_claim.expires_at > ${request.now}
          )
          AND NOT EXISTS (
            SELECT 1 FROM rika_turns active_turn
            WHERE active_turn.thread_id = turn_record.thread_id AND active_turn.turn_kind = 'AgentExecution'
              AND active_turn.status IN ('accepted', 'running', 'waiting', 'cancelling')
          )
        ORDER BY turn_record.created_at, turn_record.id
        FOR UPDATE OF turn_record SKIP LOCKED LIMIT 1`),
        false,
      )
    const claimRecovery: HostedTurnWorkerStoreService["claimRecovery"] = (request) =>
      claim(
        sql,
        request,
        query(sql<TurnRow>`SELECT thread_record.owner_id AS "ownerId", turn_record.thread_id AS "threadId",
          turn_record.id AS "turnId", hosted_thread.workspace_id AS "workspaceId", turn_record.prompt,
          turn_record.prompt_parts_json AS "promptPartsJson", turn_record.execution_route_json AS "executionRouteJson"
        FROM rika_turn_admission_outbox admission
        JOIN rika_turns turn_record ON turn_record.id = admission.turn_id
        JOIN rika_threads thread_record ON thread_record.id = turn_record.thread_id
        JOIN rika_hosted_threads hosted_thread ON hosted_thread.id = turn_record.thread_id
          AND hosted_thread.owner_id = thread_record.owner_id
        WHERE turn_record.turn_kind = 'AgentExecution' AND turn_record.status = 'running'
          AND turn_record.execution_link_json IS NULL
          AND (hosted_thread.executor_kind = 'local_device' OR EXISTS (
            SELECT 1 FROM rika_hosted_executor_assignments assignment
            JOIN rika_hosted_workspace_preparations preparation
              ON preparation.assignment_id = assignment.id
              AND preparation.generation = assignment.generation
              AND preparation.lease_epoch = assignment.lease_epoch
              AND preparation.state = 'ready'
            WHERE assignment.id = hosted_thread.id AND assignment.lifecycle = 'active'
              AND assignment.lease_expires_at > clock_timestamp()
          ))
          AND NOT EXISTS (
            SELECT 1 FROM rika_hosted_turn_claims active_claim
            WHERE active_claim.turn_id = turn_record.id AND active_claim.expires_at > ${request.now}
          )
        ORDER BY admission.prepared_at, admission.turn_id
        FOR UPDATE OF turn_record SKIP LOCKED LIMIT 1`),
        true,
      )
    const prepare: HostedTurnWorkerStoreService["prepare"] = Effect.fn("HostedTurnWorkerStore.prepare")(
      function* (turnClaim, now) {
        const encoded = yield* Schema.encodeEffect(StartTurnJson)(turnClaim.input).pipe(Effect.mapError(failure))
        return yield* transaction(
          sql,
          Effect.gen(function* () {
            const authority = yield* query(sql`SELECT 1 FROM rika_hosted_turn_claims
              WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
                AND claim_token = ${turnClaim.claimToken} AND expires_at > ${now} FOR UPDATE`)
            if (authority[0] === undefined) return false
            const transitioned = yield* query(sql`UPDATE rika_turns
              SET status = 'running', updated_at = ${now}, queue_claim_token = NULL
              WHERE id = ${turnClaim.input.turnId} AND thread_id = ${turnClaim.input.threadId}
                AND turn_kind = 'AgentExecution' AND status = 'queued' RETURNING thread_id`)
            if (transitioned[0] === undefined) {
              const prepared = yield* query(sql`SELECT 1 FROM rika_turn_admission_outbox
                WHERE turn_id = ${turnClaim.input.turnId}`)
              return prepared[0] !== undefined
            }
            const queue = yield* query(sql`UPDATE rika_thread_queue_state
              SET revision = revision + 1, queued_count = CASE WHEN queued_count > 0 THEN queued_count - 1 ELSE 0 END
              WHERE thread_id = ${turnClaim.input.threadId} RETURNING thread_id`)
            if (queue[0] === undefined) return yield* failure("Turn queue state is missing")
            yield* query(sql`INSERT INTO rika_turn_admission_outbox (turn_id, start_input_json, prepared_at)
              VALUES (${turnClaim.input.turnId}, ${encoded}, ${now})`)
            return true
          }),
        )
      },
    )
    const renew: HostedTurnWorkerStoreService["renew"] = Effect.fn("HostedTurnWorkerStore.renew")(
      function* (turnClaim, now, leaseMillis) {
        const rows = yield* query(sql`UPDATE rika_hosted_turn_claims
          SET heartbeat_at = ${now}, expires_at = ${now + leaseMillis}
          WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
            AND claim_token = ${turnClaim.claimToken} AND expires_at > ${now}
          RETURNING turn_id`)
        return rows[0] !== undefined
      },
    )
    const complete: HostedTurnWorkerStoreService["complete"] = Effect.fn("HostedTurnWorkerStore.complete")(
      function* (turnClaim, link, now) {
        if (link.turnId !== turnClaim.input.turnId || link.threadId !== turnClaim.input.threadId)
          return yield* failure("Execution link does not identify the claimed Turn")
        const encoded = yield* Schema.encodeEffect(ExecutionLinkJson)(link).pipe(Effect.mapError(failure))
        yield* transaction(
          sql,
          Effect.gen(function* () {
            const authority = yield* query(sql`SELECT 1 FROM rika_hosted_turn_claims
              WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
                AND claim_token = ${turnClaim.claimToken} FOR UPDATE`)
            if (authority[0] === undefined) return yield* failure("Turn claim is no longer owned by this worker")
            const rows = yield* query(sql<{ readonly executionLinkJson: string | null }>`SELECT
              execution_link_json AS "executionLinkJson" FROM rika_turns
              WHERE id = ${turnClaim.input.turnId} AND thread_id = ${turnClaim.input.threadId} FOR UPDATE`)
            const existing = rows[0]
            if (existing === undefined) return yield* failure("Claimed Turn does not exist")
            if (existing.executionLinkJson !== null) {
              const persisted = yield* Schema.decodeUnknownEffect(ExecutionLinkJson)(existing.executionLinkJson).pipe(
                Effect.mapError(failure),
              )
              if (!Schema.toEquivalence(ExecutionGateway.ExecutionLink)(persisted, link))
                return yield* failure("Claimed Turn already has a different execution link")
            } else {
              yield* query(sql`UPDATE rika_turns SET execution_link_json = ${encoded}, updated_at = ${now}
                WHERE id = ${turnClaim.input.turnId}`)
            }
            yield* query(sql`DELETE FROM rika_turn_admission_outbox WHERE turn_id = ${turnClaim.input.turnId}`)
            yield* query(sql`DELETE FROM rika_hosted_turn_claims
              WHERE turn_id = ${turnClaim.input.turnId} AND claim_token = ${turnClaim.claimToken}`)
          }),
        )
      },
    )
    const release: HostedTurnWorkerStoreService["release"] = Effect.fn("HostedTurnWorkerStore.release")(
      function* (turnClaim) {
        yield* query(sql`DELETE FROM rika_hosted_turn_claims
          WHERE turn_id = ${turnClaim.input.turnId} AND worker_id = ${turnClaim.workerId}
            AND claim_token = ${turnClaim.claimToken}
            AND EXISTS (SELECT 1 FROM rika_turns WHERE id = ${turnClaim.input.turnId} AND status = 'queued')`).pipe(
          Effect.asVoid,
        )
      },
    )
    return HostedTurnWorkerStore.of({ claimNext, claimRecovery, prepare, renew, complete, release })
  }),
)
