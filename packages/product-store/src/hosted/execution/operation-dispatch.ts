import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, eq, exists, gt, isNotNull, isNull, or, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { cliRegistration, identityMember } from "@rika/identity"
import {
  rikaHostedExecutorAssignments,
  rikaHostedExecutorOperations,
  rikaHostedOwners,
  rikaHostedRunnerAdmissions,
  rikaHostedWorkspaceCapabilityAdmissions,
} from "../../database/schema/product"
import type { HostedExecutionOperationsService, OperationRecord } from "./operation-contract"
import { decodeOperation, failure, operationKey, operationRows, query } from "./operation-row"

export const operationsStore = (db: PgDrizzle.EffectPgDatabase) => {
  const findOperation: HostedExecutionOperationsService["findOperation"] = (input, lock) =>
    query(operationRows.select(db, input, lock)).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.void.pipe(Effect.as<OperationRecord | undefined>(undefined))
          : decodeOperation(rows[0]),
      ),
    )
  const upsertOperation: HostedExecutionOperationsService["upsertOperation"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const assignments = yield* query(
            tx
              .select({ ownerId: rikaHostedExecutorAssignments.ownerId })
              .from(rikaHostedExecutorAssignments)
              .where(eq(rikaHostedExecutorAssignments.id, input.assignmentId)),
          )
          const assignment = assignments[0]
          if (assignment === undefined) return undefined
          yield* query(
            tx
              .insert(rikaHostedExecutorOperations)
              .values({
                ...input,
                ownerId: assignment.ownerId,
                deadlineAt: DateTime.toDate(DateTime.makeUnsafe(input.deadlineAt)),
                state: "accepted",
              })
              .onConflictDoNothing(),
          )
          const rows = yield* query(operationRows.select(tx, input))
          return rows[0] === undefined ? undefined : yield* decodeOperation(rows[0])
        }),
      )
      .pipe(Effect.mapError(failure))
  const claimDispatch: HostedExecutionOperationsService["claimDispatch"] = (input, fence, sessionDigest) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const assignmentPredicate = and(
            eq(rikaHostedExecutorAssignments.id, input.assignmentId),
            eq(rikaHostedExecutorAssignments.lifecycle, "active"),
            eq(rikaHostedExecutorAssignments.capabilityGeneration, rikaHostedExecutorAssignments.generation),
            eq(rikaHostedExecutorAssignments.generation, fence.assignmentGeneration),
            eq(rikaHostedExecutorAssignments.leaseEpoch, fence.leaseEpoch),
            gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`),
            eq(rikaHostedExecutorAssignments.providerInstanceId, fence.providerInstanceId),
            eq(rikaHostedExecutorAssignments.executorInstanceId, fence.executorInstanceId),
            eq(rikaHostedExecutorAssignments.processIncarnation, fence.processIncarnation),
            sessionDigest === undefined ? sql`true` : eq(rikaHostedExecutorAssignments.sessionDigest, sessionDigest),
          )
          const assignments = yield* query(
            tx
              .select({
                id: rikaHostedExecutorAssignments.id,
                ownerId: rikaHostedExecutorAssignments.ownerId,
                executorKind: rikaHostedExecutorAssignments.executorKind,
              })
              .from(rikaHostedExecutorAssignments)
              .innerJoin(
                rikaHostedWorkspaceCapabilityAdmissions,
                and(
                  eq(rikaHostedWorkspaceCapabilityAdmissions.assignmentId, rikaHostedExecutorAssignments.id),
                  eq(rikaHostedWorkspaceCapabilityAdmissions.threadId, input.threadId),
                  eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, input.turnId),
                  eq(rikaHostedWorkspaceCapabilityAdmissions.workspaceId, input.workspaceId),
                  eq(
                    rikaHostedWorkspaceCapabilityAdmissions.assignmentGeneration,
                    rikaHostedExecutorAssignments.generation,
                  ),
                  sql`${rikaHostedWorkspaceCapabilityAdmissions.environmentDigest} = ${rikaHostedExecutorAssignments.capabilitySnapshot}->>'environmentDigest'`,
                ),
              )
              .where(and(assignmentPredicate, eq(rikaHostedExecutorAssignments.threadId, input.threadId)))
              .for("update"),
          )
          const assignment = assignments[0]
          if (assignment === undefined) return "fenced"
          if (assignment.executorKind === "runner") {
            const admissions = yield* query(
              tx
                .select({ id: rikaHostedRunnerAdmissions.assignmentId })
                .from(rikaHostedRunnerAdmissions)
                .innerJoin(
                  cliRegistration,
                  and(
                    eq(cliRegistration.clientId, rikaHostedRunnerAdmissions.clientId),
                    sql`${cliRegistration.deviceId}::text = ${rikaHostedRunnerAdmissions.deviceId}`,
                    eq(cliRegistration.userId, rikaHostedRunnerAdmissions.userId),
                    isNull(cliRegistration.revokedAt),
                  ),
                )
                .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedRunnerAdmissions.ownerId))
                .where(
                  and(
                    eq(rikaHostedRunnerAdmissions.assignmentId, assignment.id),
                    eq(rikaHostedRunnerAdmissions.ownerId, assignment.ownerId),
                    eq(rikaHostedRunnerAdmissions.generation, fence.assignmentGeneration),
                    eq(rikaHostedRunnerAdmissions.deviceId, fence.providerInstanceId),
                    eq(rikaHostedRunnerAdmissions.processIncarnation, fence.processIncarnation),
                    isNotNull(rikaHostedRunnerAdmissions.consumedAt),
                    isNull(rikaHostedRunnerAdmissions.revokedAt),
                    or(
                      and(
                        eq(rikaHostedOwners.kind, "personal"),
                        eq(rikaHostedOwners.userId, rikaHostedRunnerAdmissions.userId),
                      ),
                      and(
                        eq(rikaHostedOwners.kind, "organization"),
                        exists(
                          tx
                            .select({ id: identityMember.id })
                            .from(identityMember)
                            .where(
                              and(
                                eq(identityMember.organizationId, rikaHostedOwners.organizationId),
                                eq(identityMember.userId, rikaHostedRunnerAdmissions.userId),
                              ),
                            ),
                        ),
                      ),
                    ),
                  ),
                )
                .for("update"),
            )
            if (admissions[0] === undefined) return "fenced"
          }
          const rows = yield* query(operationRows.select(tx, input, "update"))
          const row = rows[0]
          if (row === undefined) return "missing"
          if (row.state === "dispatched")
            return row.dispatchedGeneration === fence.assignmentGeneration &&
              row.dispatchedLeaseEpoch === fence.leaseEpoch &&
              row.dispatchedExecutorInstanceId === fence.executorInstanceId &&
              row.dispatchedProcessIncarnation === fence.processIncarnation
              ? "same-fence"
              : "fenced"
          if (row.state !== "accepted") return "fenced"
          const updated = yield* query(
            tx
              .update(rikaHostedExecutorOperations)
              .set({
                state: "dispatched",
                dispatchedGeneration: fence.assignmentGeneration,
                dispatchedLeaseEpoch: fence.leaseEpoch,
                dispatchedExecutorInstanceId: fence.executorInstanceId,
                dispatchedProcessIncarnation: fence.processIncarnation,
                updatedAt: sql`clock_timestamp()`,
              })
              .where(and(operationKey(input), eq(rikaHostedExecutorOperations.state, "accepted")))
              .returning({ key: rikaHostedExecutorOperations.operationKey }),
          )
          return updated[0] === undefined ? "fenced" : "claimed"
        }),
      )
      .pipe(Effect.mapError(failure))
  return { findOperation, upsertOperation, claimDispatch }
}
