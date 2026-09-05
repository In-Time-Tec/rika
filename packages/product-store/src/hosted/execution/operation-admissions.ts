import type * as PgDrizzle from "drizzle-orm/effect-postgres"
import { and, asc, eq, exists, gt, isNotNull, isNull, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import { cliRegistration, identityMember } from "@rika/identity"
import {
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedRunnerAdmissions,
  rikaHostedRunnerRegistrations,
  rikaHostedWorkspaceCapabilityAdmissions,
} from "../../database/schema/product"
import type { HostedExecutionOperationsService } from "./operation-contract"
import { failure, query } from "./operation-row"

export const operationsStore = (db: PgDrizzle.EffectPgDatabase) => {
  const admitWorkspaceCapabilities: HostedExecutionOperationsService["admitWorkspaceCapabilities"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          // Readiness may have been checked before a replacement committed. Serialize admission
          // with assignment transitions and never pin a Turn to an already retired generation.
          const assignments = yield* query(
            tx
              .select({ id: rikaHostedExecutorAssignments.id })
              .from(rikaHostedExecutorAssignments)
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, input.assignmentId),
                  eq(rikaHostedExecutorAssignments.threadId, input.threadId),
                  eq(rikaHostedExecutorAssignments.workspaceId, input.workspaceId),
                  eq(rikaHostedExecutorAssignments.lifecycle, "active"),
                  eq(rikaHostedExecutorAssignments.generation, input.assignmentGeneration),
                  eq(rikaHostedExecutorAssignments.capabilityGeneration, input.assignmentGeneration),
                  sql`${rikaHostedExecutorAssignments.capabilitySnapshot}->>'environmentDigest' = ${input.environmentDigest}`,
                ),
              )
              .for("update"),
          )
          if (assignments[0] === undefined) return false
          // The locking SELECT may evaluate its WHERE before waiting on an unchanged row.
          // Check wall time only after owning the lock, in this same transaction.
          const live = yield* query(
            tx
              .select({ id: rikaHostedExecutorAssignments.id })
              .from(rikaHostedExecutorAssignments)
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, input.assignmentId),
                  gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`),
                ),
              ),
          )
          if (live[0] === undefined) return false
          yield* query(tx.insert(rikaHostedWorkspaceCapabilityAdmissions).values(input).onConflictDoNothing())
          const rows = yield* query(
            tx
              .select()
              .from(rikaHostedWorkspaceCapabilityAdmissions)
              .where(
                and(
                  eq(rikaHostedWorkspaceCapabilityAdmissions.threadId, input.threadId),
                  eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, input.turnId),
                ),
              ),
          )
          const row = rows[0]
          return (
            row !== undefined &&
            row.assignmentId === input.assignmentId &&
            row.workspaceId === input.workspaceId &&
            row.assignmentGeneration === input.assignmentGeneration &&
            row.environmentDigest === input.environmentDigest
          )
        }),
      )
      .pipe(Effect.mapError(failure))
  const validateWorkspaceCapabilities: HostedExecutionOperationsService["validateWorkspaceCapabilities"] = (input) =>
    query(
      db
        .select({ id: rikaHostedWorkspaceCapabilityAdmissions.assignmentId })
        .from(rikaHostedWorkspaceCapabilityAdmissions)
        .where(
          and(
            eq(rikaHostedWorkspaceCapabilityAdmissions.threadId, input.threadId),
            eq(rikaHostedWorkspaceCapabilityAdmissions.turnId, input.turnId),
            eq(rikaHostedWorkspaceCapabilityAdmissions.assignmentId, input.assignmentId),
            eq(rikaHostedWorkspaceCapabilityAdmissions.workspaceId, input.workspaceId),
            eq(rikaHostedWorkspaceCapabilityAdmissions.assignmentGeneration, input.assignmentGeneration),
            eq(rikaHostedWorkspaceCapabilityAdmissions.environmentDigest, input.environmentDigest),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  const verifyRunnerAuthority: HostedExecutionOperationsService["verifyRunnerAuthority"] = (input) =>
    query(
      db
        .select({ id: rikaHostedOwners.id })
        .from(rikaHostedOwners)
        .innerJoin(
          cliRegistration,
          and(
            eq(cliRegistration.clientId, input.clientId),
            sql`${cliRegistration.deviceId}::text = ${input.deviceId}`,
            eq(cliRegistration.userId, input.userId),
            isNull(cliRegistration.revokedAt),
            input.dpopJkt === undefined ? sql`true` : eq(cliRegistration.jwkThumbprint, input.dpopJkt),
          ),
        )
        .where(
          and(
            eq(rikaHostedOwners.id, input.ownerId),
            or(
              and(eq(rikaHostedOwners.kind, "personal"), eq(rikaHostedOwners.userId, input.userId)),
              and(
                eq(rikaHostedOwners.kind, "organization"),
                exists(
                  db
                    .select({ id: identityMember.id })
                    .from(identityMember)
                    .where(
                      and(
                        eq(identityMember.organizationId, rikaHostedOwners.organizationId),
                        eq(identityMember.userId, input.userId),
                      ),
                    ),
                ),
              ),
            ),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  const runnerPrincipal: HostedExecutionOperationsService["runnerPrincipal"] = (input) =>
    query(
      db
        .select({
          deviceId: rikaHostedRunnerAdmissions.deviceId,
          clientId: rikaHostedRunnerAdmissions.clientId,
          userId: rikaHostedRunnerAdmissions.userId,
        })
        .from(rikaHostedRunnerAdmissions)
        .where(
          and(
            eq(rikaHostedRunnerAdmissions.assignmentId, input.assignmentId),
            eq(rikaHostedRunnerAdmissions.generation, input.generation),
            eq(rikaHostedRunnerAdmissions.deviceId, input.deviceId),
            eq(rikaHostedRunnerAdmissions.processIncarnation, input.processIncarnation),
            isNotNull(rikaHostedRunnerAdmissions.consumedAt),
            isNull(rikaHostedRunnerAdmissions.revokedAt),
          ),
        )
        .orderBy(asc(rikaHostedRunnerAdmissions.consumedAt))
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0]))
  const hasConsumedRunnerAdmission: HostedExecutionOperationsService["hasConsumedRunnerAdmission"] = (input) =>
    query(
      db
        .select({ id: rikaHostedRunnerAdmissions.id })
        .from(rikaHostedRunnerAdmissions)
        .where(
          and(
            eq(rikaHostedRunnerAdmissions.assignmentId, input.assignmentId),
            eq(rikaHostedRunnerAdmissions.ownerId, input.ownerId),
            eq(rikaHostedRunnerAdmissions.generation, input.generation),
            eq(rikaHostedRunnerAdmissions.deviceId, input.deviceId),
            eq(rikaHostedRunnerAdmissions.clientId, input.clientId),
            isNotNull(rikaHostedRunnerAdmissions.consumedAt),
            isNull(rikaHostedRunnerAdmissions.revokedAt),
          ),
        )
        .limit(1),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  const lockRemoteCreationAdmission: HostedExecutionOperationsService["lockRemoteCreationAdmission"] = (
    deviceId,
    checkoutFingerprint,
  ) =>
    query(
      db
        .select({ id: rikaHostedRunnerRegistrations.deviceId })
        .from(rikaHostedRunnerRegistrations)
        .where(
          and(
            eq(rikaHostedRunnerRegistrations.deviceId, deviceId),
            eq(rikaHostedRunnerRegistrations.checkoutFingerprint, checkoutFingerprint),
            eq(rikaHostedRunnerRegistrations.remoteThreadCreationAllowed, true),
          ),
        )
        .for("update"),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  const createRunnerAdmission: HostedExecutionOperationsService["createRunnerAdmission"] = (input) =>
    query(
      db
        .insert(rikaHostedRunnerAdmissions)
        .values({ ...input, expiresAt: sql`clock_timestamp() + (${input.lifetimeMillis} * interval '1 millisecond')` })
        .returning({ expiresAt: rikaHostedRunnerAdmissions.expiresAt }),
    ).pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.fail(failure("Runner admission was not persisted"))
          : Effect.succeed(rows[0].expiresAt.getTime()),
      ),
    )
  const lockRunnerAdmission: HostedExecutionOperationsService["lockRunnerAdmission"] = (id) =>
    query(
      db
        .select()
        .from(rikaHostedRunnerAdmissions)
        .where(
          and(
            eq(rikaHostedRunnerAdmissions.id, id),
            isNull(rikaHostedRunnerAdmissions.consumedAt),
            isNull(rikaHostedRunnerAdmissions.revokedAt),
            gt(rikaHostedRunnerAdmissions.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .for("update"),
    ).pipe(Effect.map((rows) => rows[0]))
  const consumeRunnerAdmission: HostedExecutionOperationsService["consumeRunnerAdmission"] = (id, processIncarnation) =>
    query(
      db
        .update(rikaHostedRunnerAdmissions)
        .set({ consumedAt: sql`transaction_timestamp()`, processIncarnation })
        .where(
          and(
            eq(rikaHostedRunnerAdmissions.id, id),
            isNull(rikaHostedRunnerAdmissions.consumedAt),
            gt(rikaHostedRunnerAdmissions.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .returning({ id: rikaHostedRunnerAdmissions.id }),
    ).pipe(Effect.map((rows) => rows[0] !== undefined))
  return {
    admitWorkspaceCapabilities,
    validateWorkspaceCapabilities,
    verifyRunnerAuthority,
    runnerPrincipal,
    hasConsumedRunnerAdmission,
    lockRemoteCreationAdmission,
    createRunnerAdmission,
    lockRunnerAdmission,
    consumeRunnerAdmission,
  }
}
