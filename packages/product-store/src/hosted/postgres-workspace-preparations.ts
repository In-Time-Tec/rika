import * as PgClient from "@effect/sql-pg/PgClient"
import * as PgDrizzle from "drizzle-orm/effect-postgres"
import {
  WorkspacePreparation,
  WorkspacePreparationError,
  WorkspacePreparationEvidence,
  WorkspacePreparations,
  type WorkspacePreparationsService,
} from "@rika/product/workspace-preparation"
import { and, desc, eq, sql as expression } from "drizzle-orm"
import { Effect, Layer, Redacted, Schema } from "effect"
import {
  rikaHostedExecutorAssignments,
  rikaHostedWorkspacePreparationOutput,
  rikaHostedWorkspacePreparations,
} from "../database/schema/product"

const failure = (reason: WorkspacePreparationError["reason"], message: string) =>
  WorkspacePreparationError.make({ reason, message })
const databaseError = (cause: unknown) =>
  failure("database", `Workspace preparation database operation failed: ${String(cause)}`)
const query = <A extends object, E, R>(statement: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  statement.pipe(Effect.mapError(databaseError))
const equivalentEvidence = Schema.toEquivalence(WorkspacePreparationEvidence)
const preparationFields = {
  assignmentId: rikaHostedWorkspacePreparations.assignmentId,
  ownerId: rikaHostedWorkspacePreparations.ownerId,
  workspaceId: rikaHostedWorkspacePreparations.workspaceId,
  generation: rikaHostedWorkspacePreparations.generation,
  leaseEpoch: rikaHostedWorkspacePreparations.leaseEpoch,
  attempt: rikaHostedWorkspacePreparations.attempt,
  state: rikaHostedWorkspacePreparations.state,
  phase: rikaHostedWorkspacePreparations.phase,
  evidence: rikaHostedWorkspacePreparations.evidence,
  failure: rikaHostedWorkspacePreparations.failure,
  startedAt: rikaHostedWorkspacePreparations.startedAt,
  updatedAt: rikaHostedWorkspacePreparations.updatedAt,
}

const make = Effect.gen(function* (): Effect.fn.Return<WorkspacePreparationsService, never, PgClient.PgClient> {
  yield* PgClient.PgClient
  const db = yield* PgDrizzle.makeWithDefaults()

  const select = (assignmentId: string, generation: string) => query(db.select(preparationFields)
    .from(rikaHostedWorkspacePreparations).where(and(
      eq(rikaHostedWorkspacePreparations.assignmentId, assignmentId),
      eq(rikaHostedWorkspacePreparations.generation, Number(generation)),
    )))

  const decode = (row: typeof rikaHostedWorkspacePreparations.$inferSelect) =>
    Schema.decodeUnknownEffect(WorkspacePreparation)({
      ...row,
      generation: String(row.generation),
      leaseEpoch: String(row.leaseEpoch),
      startedAt: row.startedAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    }).pipe(Effect.mapError(databaseError))

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
    const rows = yield* query(db.select({
      ownerId: rikaHostedExecutorAssignments.ownerId,
      workspaceId: rikaHostedExecutorAssignments.workspaceId,
      repositoryId: expression<string | null>`${rikaHostedExecutorAssignments.checkout} ->> 'repositoryId'`,
      commitSha: expression<string | null>`${rikaHostedExecutorAssignments.checkout} ->> 'commitSha'`,
    }).from(rikaHostedExecutorAssignments).where(and(
      eq(rikaHostedExecutorAssignments.id, access.assignmentId),
      eq(rikaHostedExecutorAssignments.generation, Number(access.assignmentGeneration)),
      eq(rikaHostedExecutorAssignments.lifecycle, "active"),
      eq(rikaHostedExecutorAssignments.providerInstanceId, access.providerInstanceId),
      eq(rikaHostedExecutorAssignments.executorInstanceId, access.executorInstanceId),
      eq(rikaHostedExecutorAssignments.processIncarnation, access.processIncarnation),
      eq(rikaHostedExecutorAssignments.leaseEpoch, Number(access.leaseEpoch)),
      expression`${rikaHostedExecutorAssignments.leaseExpiresAt} > clock_timestamp()`,
      eq(rikaHostedExecutorAssignments.sessionDigest, Redacted.value(access.presentedSessionCredentialDigest)),
    )))
    if (rows[0] === undefined) return yield* failure("stale-fence", "Workspace preparation fence is stale")
    return rows[0]
  })

  const start: WorkspacePreparationsService["start"] = Effect.fn("PostgresWorkspacePreparations.start")(
    function* (input) {
      const assignment = yield* authenticate(input.access)
      if (assignment.workspaceId !== input.workspaceId)
        return yield* failure("invalid", "Workspace preparation identity does not match its assignment")
      const leaseEpoch = Number(input.access.leaseEpoch)
      const at = expression<Date>`to_timestamp(${input.now} / 1000.0)`
      yield* query(db.insert(rikaHostedWorkspacePreparations).values({
        assignmentId: input.access.assignmentId,
        ownerId: assignment.ownerId,
        workspaceId: assignment.workspaceId,
        generation: Number(input.access.assignmentGeneration),
        leaseEpoch,
        attempt: input.attempt,
        state: "preparing",
        phase: input.phase,
        evidence: null,
        failure: null,
        startedAt: at,
        updatedAt: at,
      }).onConflictDoUpdate({
        target: [rikaHostedWorkspacePreparations.assignmentId, rikaHostedWorkspacePreparations.generation],
        set: {
          leaseEpoch: expression`excluded.lease_epoch`,
          attempt: expression`excluded.attempt`,
          state: "preparing",
          phase: expression`excluded.phase`,
          evidence: null,
          failure: null,
          updatedAt: expression`excluded.updated_at`,
        },
        setWhere: expression`${rikaHostedWorkspacePreparations.leaseEpoch} < excluded.lease_epoch OR
          (${rikaHostedWorkspacePreparations.leaseEpoch} = excluded.lease_epoch AND (
            (${rikaHostedWorkspacePreparations.attempt} = excluded.attempt AND
              ${rikaHostedWorkspacePreparations.state} = 'preparing' AND
              ${rikaHostedWorkspacePreparations.phase} <= excluded.phase)
            OR (${rikaHostedWorkspacePreparations.attempt} < excluded.attempt AND
              ${rikaHostedWorkspacePreparations.state} = 'failed' AND
              (${rikaHostedWorkspacePreparations.failure} ->> 'retryable')::boolean)))`,
      }))
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
    const generation = Number(input.access.assignmentGeneration)
    const inserted = yield* query(db.insert(rikaHostedWorkspacePreparationOutput).select(
      db.select({
        assignmentId: expression<string>`${input.access.assignmentId}`.as("assignment_id"),
        generation: expression<number>`${generation}`.as("generation"),
        attempt: expression<number>`${input.attempt}`.as("attempt"),
        phase: expression<typeof input.phase>`${input.phase}`.as("phase"),
        stream: expression<typeof input.stream>`${input.stream}`.as("stream"),
        text: expression<string>`${input.text}`.as("text"),
        redacted: expression<boolean>`true`.as("redacted"),
        truncated: expression<boolean>`${input.truncated}`.as("truncated"),
        createdAt: expression<Date>`to_timestamp(${input.now} / 1000.0)`.as("created_at"),
      }).from(rikaHostedWorkspacePreparations).where(and(
        eq(rikaHostedWorkspacePreparations.assignmentId, input.access.assignmentId),
        eq(rikaHostedWorkspacePreparations.generation, generation),
        eq(rikaHostedWorkspacePreparations.leaseEpoch, Number(input.access.leaseEpoch)),
        eq(rikaHostedWorkspacePreparations.attempt, input.attempt),
        eq(rikaHostedWorkspacePreparations.state, "preparing"),
      )),
    ).returning({ sequence: rikaHostedWorkspacePreparationOutput.sequence }))
    if (inserted[0] === undefined) return yield* failure("stale-fence", "Workspace preparation output fence is stale")
    const retained = db.select({ sequence: rikaHostedWorkspacePreparationOutput.sequence })
      .from(rikaHostedWorkspacePreparationOutput).where(and(
        eq(rikaHostedWorkspacePreparationOutput.assignmentId, input.access.assignmentId),
        eq(rikaHostedWorkspacePreparationOutput.generation, generation),
      )).orderBy(desc(rikaHostedWorkspacePreparationOutput.sequence)).limit(64)
    yield* query(db.delete(rikaHostedWorkspacePreparationOutput).where(and(
      eq(rikaHostedWorkspacePreparationOutput.assignmentId, input.access.assignmentId),
      eq(rikaHostedWorkspacePreparationOutput.generation, generation),
      expression`${rikaHostedWorkspacePreparationOutput.sequence} not in (${retained})`,
    )))
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
    const rows = yield* query(db.update(rikaHostedWorkspacePreparations).set({
      state: completed ? "ready" : "failed",
      phase: input.phase,
      evidence: completed ? input.evidence : null,
      failure: completed ? null : { message: message!, retryable: input.retryable },
      updatedAt: expression`to_timestamp(${input.now} / 1000.0)`,
    }).where(and(
      eq(rikaHostedWorkspacePreparations.assignmentId, input.access.assignmentId),
      eq(rikaHostedWorkspacePreparations.generation, Number(input.access.assignmentGeneration)),
      eq(rikaHostedWorkspacePreparations.leaseEpoch, Number(input.access.leaseEpoch)),
      eq(rikaHostedWorkspacePreparations.attempt, input.attempt),
      eq(rikaHostedWorkspacePreparations.state, "preparing"),
    )).returning({ assignmentId: rikaHostedWorkspacePreparations.assignmentId }))
    if (rows[0] === undefined) {
      const existing = yield* current(input.access.assignmentId, input.access.assignmentGeneration)
      const duplicate = completed
        ? existing.state === "ready" && existing.leaseEpoch === input.access.leaseEpoch &&
          existing.attempt === input.attempt && existing.phase === input.phase && existing.evidence !== null &&
          equivalentEvidence(existing.evidence, input.evidence)
        : existing.state === "failed" && existing.leaseEpoch === input.access.leaseEpoch &&
          existing.attempt === input.attempt && existing.phase === input.phase &&
          existing.failure?.message === message && existing.failure.retryable === input.retryable
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
    if (preparation.leaseEpoch !== access.leaseEpoch || preparation.state !== "failed" ||
      preparation.failure?.retryable !== true)
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
