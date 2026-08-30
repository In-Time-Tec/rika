import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { Effect, Redacted } from "effect"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core"
import type { ExecutorAssignment } from "@rika/product/executor-assignment"
import type { AssignmentError, AssignmentsService, Fence, Version } from "@rika/product/executor-assignments"
import type { PgUpdateSetSource } from "drizzle-orm/pg-core"
import type { rikaHostedExecutorAssignments } from "../../database/schema/product"
import type { AssignmentRow } from "./assignment-row"

export interface AssignmentOperations {
  readonly db: PgDrizzle.EffectPgDatabase
  readonly transaction: <A>(
    effect: (tx: PgDrizzle.EffectPgDatabase) => Effect.Effect<A, AssignmentError>,
  ) => Effect.Effect<A, AssignmentError>
  readonly locked: (
    executor: PgDrizzle.EffectPgDatabase,
    assignmentId: string,
    lock: "share" | "update",
  ) => Effect.Effect<AssignmentRow, AssignmentError>
  readonly updated: (
    executor: PgDrizzle.EffectPgDatabase,
    assignmentId: string,
    statement: Effect.Effect<ReadonlyArray<object>, EffectDrizzleQueryError>,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly updateVersion: (
    tx: PgDrizzle.EffectPgDatabase,
    input: Version,
    values: PgUpdateSetSource<typeof rikaHostedExecutorAssignments>,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string }>, EffectDrizzleQueryError>
  readonly updateFence: (
    tx: PgDrizzle.EffectPgDatabase,
    input: Fence,
    values: PgUpdateSetSource<typeof rikaHostedExecutorAssignments>,
  ) => Effect.Effect<ReadonlyArray<{ readonly id: string }>, EffectDrizzleQueryError>
  readonly query: <A extends object, E, R>(
    statement: Effect.Effect<ReadonlyArray<A>, E, R>,
  ) => Effect.Effect<ReadonlyArray<A>, AssignmentError, R>
  readonly failure: (reason: AssignmentError["reason"], message: string) => AssignmentError
  readonly checkVersion: (row: AssignmentRow, input: Version) => Effect.Effect<void, AssignmentError>
  readonly checkFence: (row: AssignmentRow, input: Fence) => Effect.Effect<void, AssignmentError>
  readonly checkAccess: (
    row: AssignmentRow,
    input: Parameters<AssignmentsService["authenticate"]>[0],
    requireLiveLease: boolean,
  ) => Effect.Effect<void, AssignmentError>
}

const checkVersion = (failure: AssignmentOperations["failure"], row: AssignmentRow, input: Version) =>
  row.generation === input.generation && row.revision === input.revision
    ? Effect.void
    : Effect.fail(failure("conflict", "Executor assignment revision is stale"))

const checkFence = (failure: AssignmentOperations["failure"], row: AssignmentRow, input: Fence) =>
  row.lifecycle === "active" && row.generation === input.assignmentGeneration && row.leaseEpoch === input.leaseEpoch
    ? Effect.void
    : Effect.fail(failure("stale-fence", "Executor assignment fence is stale"))

const checkAccess = (
  failure: AssignmentOperations["failure"],
  row: AssignmentRow,
  input: Parameters<AssignmentsService["authenticate"]>[0],
  requireLiveLease: boolean,
) =>
  Effect.gen(function* () {
    yield* checkFence(failure, row, input)
    if (
      row.providerInstanceId !== input.providerInstanceId ||
      row.executorInstanceId !== input.executorInstanceId ||
      row.processIncarnation !== input.processIncarnation ||
      (requireLiveLease && !row.leaseLive)
    )
      return yield* failure("stale-fence", "Executor assignment fence is stale")
    if (
      row.sessionCredentialDigest === null ||
      row.sessionCredentialDigest !== Redacted.value(input.presentedSessionCredentialDigest)
    )
      return yield* failure("authentication", "Executor session credential is invalid")
  })

export const assignmentChecks = { checkVersion, checkFence, checkAccess }
