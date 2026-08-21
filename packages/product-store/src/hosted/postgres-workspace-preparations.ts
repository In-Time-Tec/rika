import * as PgClient from "@effect/sql-pg/PgClient"
import { Effect, Layer, Redacted, Schema } from "effect"
import {
  WorkspacePreparation,
  WorkspacePreparationError,
  WorkspacePreparationEvidence,
  WorkspacePreparations,
  type WorkspacePreparationsService,
} from "@rika/product/workspace-preparation"

interface PreparationRow {
  readonly assignmentId: string
  readonly ownerId: string
  readonly workspaceId: string
  readonly generation: string
  readonly leaseEpoch: string
  readonly attempt: number
  readonly state: "preparing" | "ready" | "failed"
  readonly phase: "checkout" | "setup" | "resume" | "capabilities"
  readonly evidence: unknown
  readonly failure: unknown
  readonly startedAt: number
  readonly updatedAt: number
}

const failure = (reason: WorkspacePreparationError["reason"], message: string) =>
  WorkspacePreparationError.make({ reason, message })
const databaseError = (cause: unknown) =>
  failure("database", `Workspace preparation database operation failed: ${String(cause)}`)
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const equivalentEvidence = Schema.toEquivalence(WorkspacePreparationEvidence)
const make = Effect.gen(function* (): Effect.fn.Return<WorkspacePreparationsService, never, PgClient.PgClient> {
  const sql = yield* PgClient.PgClient

  const select = (assignmentId: string, generation: string) =>
    query(sql<PreparationRow>`SELECT assignment_id AS "assignmentId", owner_id AS "ownerId",
      workspace_id AS "workspaceId", generation::text AS generation, lease_epoch::text AS "leaseEpoch",
      attempt, state, phase, evidence, failure,
      (extract(epoch FROM started_at) * 1000)::float8 AS "startedAt",
      (extract(epoch FROM updated_at) * 1000)::float8 AS "updatedAt"
      FROM rika_hosted_workspace_preparations
      WHERE assignment_id = ${assignmentId} AND generation = ${generation}::bigint`)

  const decode = (row: PreparationRow) =>
    Schema.decodeUnknownEffect(WorkspacePreparation)(row).pipe(Effect.mapError(databaseError))

  const current = Effect.fn("PostgresWorkspacePreparations.current")(function* (
    assignmentId: string,
    generation: string,
  ) {
    const row = (yield* select(assignmentId, generation))[0]
    if (row === undefined) return yield* failure("not-found", "Workspace preparation does not exist")
    return yield* decode(row)
  })

  const authenticate = Effect.fn("PostgresWorkspacePreparations.authenticate")(function* (
    access: Parameters<WorkspacePreparationsService["requireReady"]>[0],
  ) {
    const rows = yield* query(sql<{
      readonly ownerId: string
      readonly workspaceId: string
      readonly repositoryId: string | null
      readonly commitSha: string | null
    }>`SELECT owner_id AS "ownerId", workspace_id AS "workspaceId",
      checkout ->> 'repositoryId' AS "repositoryId", checkout ->> 'commitSha' AS "commitSha"
      FROM rika_hosted_executor_assignments
      WHERE id = ${access.assignmentId}
        AND generation = ${access.assignmentGeneration}::bigint
        AND lifecycle = 'active'
        AND provider_instance_id = ${access.providerInstanceId}
        AND executor_instance_id = ${access.executorInstanceId}
        AND process_incarnation = ${access.processIncarnation}
        AND lease_epoch = ${access.leaseEpoch}::bigint
        AND lease_expires_at > clock_timestamp()
        AND session_digest = ${Redacted.value(access.presentedSessionCredentialDigest)}`)
    if (rows[0] === undefined) return yield* failure("stale-fence", "Workspace preparation fence is stale")
    return rows[0]
  })

  const start: WorkspacePreparationsService["start"] = Effect.fn("PostgresWorkspacePreparations.start")(
    function* (input) {
      const assignment = yield* authenticate(input.access)
      if (assignment.workspaceId !== input.workspaceId)
        return yield* failure("invalid", "Workspace preparation identity does not match its assignment")
      yield* query(sql`INSERT INTO rika_hosted_workspace_preparations
        (assignment_id, owner_id, workspace_id, generation, lease_epoch, attempt, state, phase,
          evidence, failure, started_at, updated_at)
        VALUES (${input.access.assignmentId}, ${assignment.ownerId}, ${assignment.workspaceId},
          ${input.access.assignmentGeneration}::bigint, ${input.access.leaseEpoch}::bigint, ${input.attempt},
          'preparing', ${input.phase}, NULL, NULL, to_timestamp(${input.now} / 1000.0), to_timestamp(${input.now} / 1000.0))
        ON CONFLICT (assignment_id, generation) DO UPDATE SET
          lease_epoch = EXCLUDED.lease_epoch, attempt = EXCLUDED.attempt, state = 'preparing',
          phase = EXCLUDED.phase, evidence = NULL, failure = NULL, updated_at = EXCLUDED.updated_at
        WHERE rika_hosted_workspace_preparations.lease_epoch < EXCLUDED.lease_epoch
          OR (rika_hosted_workspace_preparations.lease_epoch = EXCLUDED.lease_epoch AND (
            (rika_hosted_workspace_preparations.attempt = EXCLUDED.attempt
              AND rika_hosted_workspace_preparations.state = 'preparing'
              AND rika_hosted_workspace_preparations.phase <= EXCLUDED.phase)
            OR (rika_hosted_workspace_preparations.attempt < EXCLUDED.attempt
              AND rika_hosted_workspace_preparations.state = 'failed'
              AND (rika_hosted_workspace_preparations.failure ->> 'retryable')::boolean)
          ))`)
      const preparation = yield* current(input.access.assignmentId, input.access.assignmentGeneration)
      if (preparation.leaseEpoch !== input.access.leaseEpoch || preparation.attempt !== input.attempt)
        return yield* failure("stale-fence", "Workspace preparation start fence is stale")
      return preparation
    },
  )

  const appendOutput: WorkspacePreparationsService["appendOutput"] = Effect.fn(
    "PostgresWorkspacePreparations.appendOutput",
  )(function* (input) {
    yield* authenticate(input.access)
    const inserted = yield* query(sql`INSERT INTO rika_hosted_workspace_preparation_output
      (assignment_id, generation, attempt, phase, stream, text, redacted, truncated, created_at)
      SELECT ${input.access.assignmentId}, ${input.access.assignmentGeneration}::bigint, ${input.attempt},
        ${input.phase}, ${input.stream}, ${input.text}, true, ${input.truncated}, to_timestamp(${input.now} / 1000.0)
      FROM rika_hosted_workspace_preparations
      WHERE assignment_id = ${input.access.assignmentId}
        AND generation = ${input.access.assignmentGeneration}::bigint
        AND lease_epoch = ${input.access.leaseEpoch}::bigint
        AND attempt = ${input.attempt} AND state = 'preparing' RETURNING sequence`)
    if (inserted[0] === undefined) return yield* failure("stale-fence", "Workspace preparation output fence is stale")
    yield* query(sql`DELETE FROM rika_hosted_workspace_preparation_output
      WHERE assignment_id = ${input.access.assignmentId}
        AND generation = ${input.access.assignmentGeneration}::bigint
        AND sequence NOT IN (
          SELECT sequence FROM rika_hosted_workspace_preparation_output
          WHERE assignment_id = ${input.access.assignmentId}
            AND generation = ${input.access.assignmentGeneration}::bigint
          ORDER BY sequence DESC LIMIT 64
        )`)
  })

  const finish = Effect.fn("PostgresWorkspacePreparations.finish")(function* (
    input:
      | Parameters<WorkspacePreparationsService["complete"]>[0]
      | Parameters<WorkspacePreparationsService["fail"]>[0],
  ) {
    const assignment = yield* authenticate(input.access)
    if (assignment.workspaceId !== input.workspaceId)
      return yield* failure("invalid", "Workspace preparation identity does not match its assignment")
    const completed = "evidence" in input
    if (
      completed &&
      (input.evidence.workspaceId !== assignment.workspaceId ||
        input.evidence.repositoryId !== assignment.repositoryId ||
        input.evidence.commitSha !== assignment.commitSha ||
        input.evidence.setup.commitSha !== assignment.commitSha ||
        (input.evidence.resume !== null && input.evidence.resume.commitSha !== assignment.commitSha))
    )
      return yield* failure("invalid", "Workspace readiness evidence does not match its assignment checkout")
    const message = completed ? null : input.message.slice(0, 2_048)
    const rows = yield* query(sql`UPDATE rika_hosted_workspace_preparations SET
      state = ${completed ? "ready" : "failed"}::rika_hosted_preparation_state,
      phase = ${input.phase}, evidence = ${completed ? sql.json(input.evidence) : null},
      failure = ${completed ? null : sql.json({ message: message!, retryable: input.retryable })},
      updated_at = to_timestamp(${input.now} / 1000.0)
      WHERE assignment_id = ${input.access.assignmentId}
        AND generation = ${input.access.assignmentGeneration}::bigint
        AND lease_epoch = ${input.access.leaseEpoch}::bigint
        AND attempt = ${input.attempt} AND state = 'preparing' RETURNING assignment_id`)
    if (rows[0] === undefined) {
      const existing = yield* current(input.access.assignmentId, input.access.assignmentGeneration)
      const duplicate = completed
        ? existing.state === "ready" &&
          existing.leaseEpoch === input.access.leaseEpoch &&
          existing.attempt === input.attempt &&
          existing.phase === input.phase &&
          existing.evidence !== null &&
          equivalentEvidence(existing.evidence, input.evidence)
        : existing.state === "failed" &&
          existing.leaseEpoch === input.access.leaseEpoch &&
          existing.attempt === input.attempt &&
          existing.phase === input.phase &&
          existing.failure?.message === message &&
          existing.failure.retryable === input.retryable
      if (!duplicate) return yield* failure("stale-fence", "Workspace preparation completion fence is stale")
    }
    return yield* current(input.access.assignmentId, input.access.assignmentGeneration)
  })

  const complete: WorkspacePreparationsService["complete"] = finish
  const fail: WorkspacePreparationsService["fail"] = finish

  const retryAttempt: WorkspacePreparationsService["retryAttempt"] = Effect.fn(
    "PostgresWorkspacePreparations.retryAttempt",
  )(function* (access) {
    yield* authenticate(access)
    const preparation = yield* current(access.assignmentId, access.assignmentGeneration)
    if (
      preparation.leaseEpoch !== access.leaseEpoch ||
      preparation.state !== "failed" ||
      preparation.failure?.retryable !== true
    )
      return yield* failure("conflict", "Workspace preparation is not retryable for the current assignment fence")
    return preparation.attempt + 1
  })

  const requireReady: WorkspacePreparationsService["requireReady"] = Effect.fn(
    "PostgresWorkspacePreparations.requireReady",
  )(function* (access) {
    yield* authenticate(access)
    const preparation = yield* current(access.assignmentId, access.assignmentGeneration)
    if (preparation.leaseEpoch !== access.leaseEpoch || preparation.state !== "ready")
      return yield* failure("conflict", "Workspace is not ready for the current assignment fence")
    return preparation
  })

  return WorkspacePreparations.of({ start, appendOutput, complete, fail, retryAttempt, requireReady })
})

export const layer = Layer.effect(WorkspacePreparations, make)
