import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { identityMember } from "@rika/identity"
import { and, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm"
import {
  ActorAttribution,
  OwnerId,
  type BetterAuthUserId,
  type HostedOwner,
  type ThreadId,
  type WorkspaceId,
} from "@rika/product/hosted-model"
import { Context, Effect, Layer, Schema } from "effect"
import {
  rikaHostedClientAuthorities,
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedRunnerRegistrations,
  rikaHostedThreadGrants,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreads,
  rikaHostedToolAuditRecords,
  rikaHostedWorkspaces,
  rikaHostedProjectGrants,
  rikaTranscriptCheckpoints,
} from "../../database/schema/product"
import {
  auditValues,
  decodeAuditRecord,
  failure,
  sameDecision,
  ToolPolicyStoreError,
  type AdmissionContext,
  type AdmissionFence,
  type AuditAppend,
  type AuditRecord,
  type DecisionAppend,
} from "./tool-policy-audit"

export * from "./tool-policy-audit"

export interface ToolPolicyStoreService {
  readonly insertAudit: (record: AuditAppend) => Effect.Effect<void, ToolPolicyStoreError>
  readonly loadAdmissionContext: (input: {
    readonly threadId: ThreadId
    readonly turnId: string
    readonly workspaceId: WorkspaceId
    readonly fence: AdmissionFence
  }) => Effect.Effect<AdmissionContext | undefined, ToolPolicyStoreError>
  readonly listAuthorizationRecords: (input: {
    readonly ownerId: OwnerId
    readonly threadId: ThreadId
    readonly turnId: string
    readonly authorizationId: string
  }) => Effect.Effect<ReadonlyArray<AuditRecord>, ToolPolicyStoreError>
  readonly appendDecision: (
    input: DecisionAppend,
  ) => Effect.Effect<"inserted" | "same" | "conflict", ToolPolicyStoreError>
  readonly resolveOwner: (input: {
    readonly principalUserId: BetterAuthUserId
    readonly owner: HostedOwner
  }) => Effect.Effect<OwnerId | undefined, ToolPolicyStoreError>
  readonly listInspectionRecords: (input: {
    readonly ownerId: OwnerId
    readonly principalUserId: BetterAuthUserId
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<AuditRecord>, ToolPolicyStoreError>
}

export class ToolPolicyStore extends Context.Service<ToolPolicyStore, ToolPolicyStoreService>()(
  "@rika/product-store/hosted/execution/tool-policy/ToolPolicyStore",
) {}

const query = <A extends object, E, R>(value: Effect.Effect<ReadonlyArray<A>, E, R>) =>
  value.pipe(Effect.mapError(failure))
const decoded = <A, E, R>(value: Effect.Effect<A, E, R>) => value.pipe(Effect.mapError(failure))

export const make = Effect.gen(function* () {
  const db = yield* PgDrizzle.makeWithDefaults()
  const insertAudit: ToolPolicyStoreService["insertAudit"] = (record) =>
    query(
      db
        .insert(rikaHostedToolAuditRecords)
        .values(auditValues(record))
        .returning({ sequence: rikaHostedToolAuditRecords.sequence }),
    ).pipe(Effect.asVoid)

  const loadAdmissionContext: ToolPolicyStoreService["loadAdmissionContext"] = (input) => {
    const admission = db.$with("admission").as(
      db
        .select({ actor: rikaHostedThreadProtocolCommands.actor })
        .from(rikaHostedThreadProtocolCommands)
        .where(
          and(
            eq(rikaHostedThreadProtocolCommands.threadId, input.threadId),
            eq(rikaHostedThreadProtocolCommands.turnId, input.turnId),
          ),
        )
        .limit(1),
    )
    const actor = admission.actor
    const userId = sql<string>`${actor} ->> 'userId'`
    const clientId = sql<string>`${actor} ->> 'clientId'`
    const deviceId = sql<string>`${actor} ->> 'deviceId'`
    const membershipId = sql<string>`${actor} ->> 'membershipId'`
    return query(
      db
        .with(admission)
        .select({
          ownerId: rikaHostedThreads.ownerId,
          actor,
          executorKind: rikaHostedExecutorAssignments.executorKind,
          repositoryIdentity: sql<
            string | null
          >`case when ${rikaHostedExecutorAssignments.executorKind} = 'runner' then ${rikaHostedRunnerRegistrations.repository} ->> 'identity' when ${rikaHostedExecutorAssignments.checkout} is not null then ${rikaHostedExecutorAssignments.checkout} ->> 'repositoryId' else null end`,
          branch: sql<
            string | null
          >`case when ${rikaHostedExecutorAssignments.executorKind} = 'runner' then coalesce(${rikaHostedRunnerRegistrations.repository} ->> 'branch', case when ${rikaHostedRunnerRegistrations.repository} ? 'headRevision' then concat('detached:', ${rikaHostedRunnerRegistrations.repository} ->> 'headRevision') end) when ${rikaHostedExecutorAssignments.checkout} is not null then concat('detached:', ${rikaHostedExecutorAssignments.checkout} ->> 'commitSha') else null end`,
        })
        .from(rikaHostedThreads)
        .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedThreads.ownerId))
        .innerJoin(
          rikaHostedWorkspaces,
          and(
            eq(rikaHostedWorkspaces.id, rikaHostedThreads.workspaceId),
            eq(rikaHostedWorkspaces.ownerId, rikaHostedThreads.ownerId),
          ),
        )
        .innerJoin(
          rikaHostedExecutorAssignments,
          and(
            eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id),
            eq(rikaHostedExecutorAssignments.ownerId, rikaHostedThreads.ownerId),
          ),
        )
        .leftJoin(
          rikaHostedRunnerRegistrations,
          and(
            eq(rikaHostedRunnerRegistrations.deviceId, sql`${rikaHostedExecutorAssignments.placement} ->> 'deviceId'`),
            eq(
              rikaHostedRunnerRegistrations.checkoutFingerprint,
              sql`${rikaHostedExecutorAssignments.placement} ->> 'checkoutFingerprint'`,
            ),
          ),
        )
        .leftJoin(admission, sql`true`)
        .innerJoin(
          rikaHostedClients,
          and(
            eq(rikaHostedClients.id, clientId),
            eq(rikaHostedClients.userId, userId),
            isNull(rikaHostedClients.revokedAt),
            gt(rikaHostedClients.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .innerJoin(
          rikaHostedClientAuthorities,
          and(
            eq(rikaHostedClientAuthorities.clientId, rikaHostedClients.id),
            eq(rikaHostedClientAuthorities.ownerId, rikaHostedThreads.ownerId),
            isNull(rikaHostedClientAuthorities.revokedAt),
            gt(rikaHostedClientAuthorities.expiresAt, sql`clock_timestamp()`),
          ),
        )
        .innerJoin(
          rikaHostedDevices,
          and(
            eq(rikaHostedDevices.id, deviceId),
            eq(rikaHostedDevices.userId, userId),
            isNull(rikaHostedDevices.revokedAt),
          ),
        )
        .leftJoin(
          identityMember,
          and(
            eq(identityMember.id, membershipId),
            eq(identityMember.organizationId, rikaHostedOwners.organizationId),
            eq(identityMember.userId, userId),
          ),
        )
        .leftJoin(
          rikaHostedThreadGrants,
          and(
            eq(rikaHostedThreadGrants.ownerId, rikaHostedThreads.ownerId),
            eq(rikaHostedThreadGrants.threadId, rikaHostedThreads.id),
            eq(rikaHostedThreadGrants.membershipId, identityMember.id),
          ),
        )
        .leftJoin(
          rikaHostedProjectGrants,
          and(
            eq(rikaHostedProjectGrants.ownerId, rikaHostedThreads.ownerId),
            eq(rikaHostedProjectGrants.projectId, rikaHostedThreads.projectId),
            eq(rikaHostedProjectGrants.membershipId, identityMember.id),
          ),
        )
        .where(
          and(
            eq(rikaHostedThreads.id, input.threadId),
            eq(rikaHostedWorkspaces.id, input.workspaceId),
            eq(rikaHostedExecutorAssignments.id, input.fence.assignmentId),
            eq(rikaHostedExecutorAssignments.executorKind, input.fence.target),
            eq(rikaHostedExecutorAssignments.generation, input.fence.generation),
            eq(rikaHostedExecutorAssignments.leaseEpoch, input.fence.leaseEpoch),
            eq(rikaHostedExecutorAssignments.providerInstanceId, input.fence.providerInstanceId),
            eq(rikaHostedExecutorAssignments.executorInstanceId, input.fence.executorInstanceId),
            eq(rikaHostedExecutorAssignments.processIncarnation, input.fence.processIncarnation),
            eq(rikaHostedExecutorAssignments.lifecycle, "active"),
            gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`),
            isNotNull(actor),
            or(
              and(eq(rikaHostedOwners.kind, "personal"), eq(rikaHostedOwners.userId, userId)),
              and(
                eq(rikaHostedOwners.kind, "organization"),
                isNotNull(identityMember.id),
                or(
                  eq(rikaHostedThreads.createdByUserId, identityMember.userId),
                  inArray(rikaHostedThreadGrants.role, ["operator", "owner"]),
                  and(
                    eq(rikaHostedThreads.executorKind, "orb"),
                    eq(rikaHostedThreads.inheritProjectGrants, true),
                    inArray(rikaHostedProjectGrants.role, ["operator", "owner"]),
                  ),
                ),
              ),
            ),
          ),
        )
        .limit(1),
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.gen(function* () {
          const row = rows[0]
          if (row === undefined) return undefined
          return {
            ownerId: yield* decoded(Schema.decodeEffect(OwnerId)(row.ownerId)),
            actor: yield* decoded(Schema.decodeUnknownEffect(ActorAttribution)(row.actor)),
            executorKind: row.executorKind,
            repositoryIdentity: row.repositoryIdentity,
            branch: row.branch,
          }
        }),
      ),
    )
  }

  const listAuthorizationRecords: ToolPolicyStoreService["listAuthorizationRecords"] = (input) =>
    query(
      db
        .select()
        .from(rikaHostedToolAuditRecords)
        .where(
          and(
            eq(rikaHostedToolAuditRecords.ownerId, input.ownerId),
            eq(rikaHostedToolAuditRecords.threadId, input.threadId),
            eq(rikaHostedToolAuditRecords.turnId, input.turnId),
            eq(rikaHostedToolAuditRecords.phase, "outcome"),
            eq(rikaHostedToolAuditRecords.outcome, "suspended"),
            eq(rikaHostedToolAuditRecords.authorizationId, input.authorizationId),
          ),
        )
        .orderBy(desc(rikaHostedToolAuditRecords.sequence)),
    ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeAuditRecord)))

  const appendDecision: ToolPolicyStoreService["appendDecision"] = (input) =>
    db
      .transaction((tx) =>
        Effect.gen(function* () {
          const existing = yield* query(
            tx
              .select()
              .from(rikaHostedToolAuditRecords)
              .where(
                and(
                  eq(rikaHostedToolAuditRecords.auditGroupId, input.record.auditGroupId),
                  eq(rikaHostedToolAuditRecords.phase, "decision"),
                ),
              )
              .limit(1),
          )
          if (existing[0] !== undefined)
            return sameDecision(input.record)(yield* decodeAuditRecord(existing[0])) ? "same" : "conflict"
          const checkpoint = yield* query(
            tx
              .select({ turnId: rikaTranscriptCheckpoints.turnId })
              .from(rikaTranscriptCheckpoints)
              .where(
                and(
                  eq(rikaTranscriptCheckpoints.turnId, input.record.turnId),
                  eq(rikaTranscriptCheckpoints.projectorVersion, input.expectedProjector.version),
                  sql<boolean>`exists (
        select 1
        from jsonb_array_elements((${rikaTranscriptCheckpoints.projectorState})::jsonb -> 'authorizations') as projected_entry
        where projected_entry ->> 0 = ${input.record.authorizationId}
          and projected_entry -> 1 ->> 'rawRunId' = ${input.expectedProjector.runId}
          and projected_entry -> 1 ->> 'approvalId' = ${input.expectedProjector.approvalId}
      )`,
                ),
              )
              .limit(1),
          )
          const executor = input.record.executor
          const fence = yield* query(
            tx
              .select({ id: rikaHostedExecutorAssignments.id })
              .from(rikaHostedExecutorAssignments)
              .where(
                and(
                  eq(rikaHostedExecutorAssignments.id, executor.assignmentId),
                  eq(rikaHostedExecutorAssignments.ownerId, input.record.ownerId),
                  eq(rikaHostedExecutorAssignments.threadId, input.record.threadId),
                  eq(rikaHostedExecutorAssignments.executorKind, executor.kind),
                  eq(rikaHostedExecutorAssignments.generation, executor.generation),
                  eq(rikaHostedExecutorAssignments.leaseEpoch, executor.leaseEpoch),
                  eq(rikaHostedExecutorAssignments.providerInstanceId, executor.instanceId),
                  eq(rikaHostedExecutorAssignments.executorInstanceId, executor.executorId),
                  eq(rikaHostedExecutorAssignments.processIncarnation, executor.processIncarnation),
                  eq(rikaHostedExecutorAssignments.lifecycle, "active"),
                  gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`),
                ),
              )
              .limit(1),
          )
          if (checkpoint[0] === undefined || fence[0] === undefined) return "conflict"
          yield* query(
            tx
              .insert(rikaHostedToolAuditRecords)
              .values(auditValues(input.record))
              .onConflictDoNothing({
                target: rikaHostedToolAuditRecords.auditGroupId,
                where: sql`${rikaHostedToolAuditRecords.phase} = 'decision'`,
              })
              .returning({ sequence: rikaHostedToolAuditRecords.sequence }),
          )
          const stored = yield* query(
            tx
              .select()
              .from(rikaHostedToolAuditRecords)
              .where(
                and(
                  eq(rikaHostedToolAuditRecords.auditGroupId, input.record.auditGroupId),
                  eq(rikaHostedToolAuditRecords.phase, "decision"),
                ),
              )
              .limit(1),
          )
          return stored[0] !== undefined && sameDecision(input.record)(yield* decodeAuditRecord(stored[0]))
            ? "inserted"
            : "conflict"
        }),
      )
      .pipe(Effect.mapError(failure))

  const resolveOwner: ToolPolicyStoreService["resolveOwner"] = (input) =>
    query(
      db
        .select({ id: rikaHostedOwners.id })
        .from(rikaHostedOwners)
        .leftJoin(
          identityMember,
          and(
            eq(identityMember.organizationId, rikaHostedOwners.organizationId),
            eq(identityMember.userId, input.principalUserId),
          ),
        )
        .where(
          or(
            and(
              eq(rikaHostedOwners.kind, "personal"),
              eq(rikaHostedOwners.userId, input.owner._tag === "PersonalOwner" ? input.owner.userId : ""),
              eq(rikaHostedOwners.userId, input.principalUserId),
            ),
            and(
              eq(rikaHostedOwners.kind, "organization"),
              eq(
                rikaHostedOwners.organizationId,
                input.owner._tag === "OrganizationOwner" ? input.owner.organizationId : "",
              ),
              isNotNull(identityMember.id),
            ),
          ),
        )
        .limit(1),
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.gen(function* () {
          const row = rows[0]
          if (row === undefined) return undefined
          return yield* decoded(Schema.decodeEffect(OwnerId)(row.id))
        }),
      ),
    )

  const listInspectionRecords: ToolPolicyStoreService["listInspectionRecords"] = (input) =>
    query(
      db
        .select({ record: rikaHostedToolAuditRecords })
        .from(rikaHostedToolAuditRecords)
        .innerJoin(
          rikaHostedThreads,
          and(
            eq(rikaHostedThreads.id, rikaHostedToolAuditRecords.threadId),
            eq(rikaHostedThreads.ownerId, rikaHostedToolAuditRecords.ownerId),
          ),
        )
        .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedToolAuditRecords.ownerId))
        .leftJoin(
          identityMember,
          and(
            eq(identityMember.organizationId, rikaHostedOwners.organizationId),
            eq(identityMember.userId, input.principalUserId),
          ),
        )
        .leftJoin(
          rikaHostedThreadGrants,
          and(
            eq(rikaHostedThreadGrants.ownerId, rikaHostedThreads.ownerId),
            eq(rikaHostedThreadGrants.threadId, rikaHostedThreads.id),
            eq(rikaHostedThreadGrants.membershipId, identityMember.id),
          ),
        )
        .leftJoin(
          rikaHostedProjectGrants,
          and(
            eq(rikaHostedProjectGrants.ownerId, rikaHostedThreads.ownerId),
            eq(rikaHostedProjectGrants.projectId, rikaHostedThreads.projectId),
            eq(rikaHostedProjectGrants.membershipId, identityMember.id),
          ),
        )
        .where(
          and(
            eq(rikaHostedToolAuditRecords.ownerId, input.ownerId),
            or(
              eq(rikaHostedOwners.kind, "personal"),
              and(
                eq(rikaHostedOwners.kind, "organization"),
                isNotNull(identityMember.id),
                or(
                  inArray(identityMember.role, ["owner", "admin"]),
                  eq(rikaHostedThreads.createdByUserId, input.principalUserId),
                  isNotNull(rikaHostedThreadGrants.membershipId),
                  and(
                    eq(rikaHostedThreads.executorKind, "orb"),
                    eq(rikaHostedThreads.inheritProjectGrants, true),
                    isNotNull(rikaHostedProjectGrants.membershipId),
                  ),
                ),
              ),
            ),
          ),
        )
        .orderBy(desc(rikaHostedToolAuditRecords.sequence))
        .limit(Math.min(Math.max(input.limit, 1), 500)),
    ).pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeAuditRecord(row.record))))

  return ToolPolicyStore.of({
    insertAudit,
    loadAdmissionContext,
    listAuthorizationRecords,
    appendDecision,
    resolveOwner,
    listInspectionRecords,
  })
})

export const layer = Layer.effect(ToolPolicyStore, make)
