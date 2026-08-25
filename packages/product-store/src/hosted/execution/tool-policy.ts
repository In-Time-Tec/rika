import * as PgDrizzle from "drizzle-orm/effect-postgres"
import { identityMember } from "@rika/identity"
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm"
import {
  ActorAttribution,
  type ActorAttribution as ActorAttributionValue,
  type BetterAuthUserId as BetterAuthUserIdValue,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  type HostedOwner,
  OwnerId,
  ThreadId,
  WorkspaceId,
} from "@rika/product/hosted-model"
import { Context, Effect, Layer, Schema } from "effect"
import {
  rikaHostedClientAuthorities,
  rikaHostedClients,
  rikaHostedDevices,
  rikaHostedExecutorAssignments,
  rikaHostedOwners,
  rikaHostedRunnerRegistrations,
  rikaHostedThreadCommands,
  rikaHostedThreadGrants,
  rikaHostedThreadProtocolCommands,
  rikaHostedThreads,
  rikaHostedToolAuditRecords,
  rikaHostedWorkspaces,
  rikaHostedProjectGrants,
  rikaTranscriptCheckpoints,
} from "../../database/schema/product"

const AuditPhase = Schema.Literals(["admission", "decision", "outcome"])
const AuditDecision = Schema.Literals(["not-required", "pending", "approved", "denied"])
const AuditOutcome = Schema.Literals(["admitted", "suspended", "succeeded", "failed", "denied", "unknown"])
const ToolPolicy = Schema.Struct({
  id: Schema.String,
  version: Schema.Int,
  capability: Schema.NonEmptyString,
  capabilities: Schema.Array(Schema.NonEmptyString),
  sideEffect: Schema.String,
  approval: Schema.String,
  replayPolicy: Schema.String,
})
const AuditCheckpoint = Schema.Struct({ version: Schema.Int, cursor: Schema.String, digest: Schema.String })
const AuditExecutor = Schema.Struct({
  kind: Schema.Literals(["runner", "orb"]),
  assignmentId: ExecutorAssignmentId,
  generation: Schema.Int,
  leaseEpoch: Schema.Int,
  instanceId: Schema.String,
  executorId: ExecutorInstanceId,
  processIncarnation: Schema.String,
})
const AuditRepository = Schema.Struct({ identity: Schema.NonEmptyString })

export type ToolPolicy = typeof ToolPolicy.Type
export type AuditCheckpoint = typeof AuditCheckpoint.Type
export type AuditExecutor = typeof AuditExecutor.Type
export type AuditRepository = typeof AuditRepository.Type
export type AuditDecision = typeof AuditDecision.Type
export type AuditOutcome = typeof AuditOutcome.Type

export interface AuditRecord {
  readonly sequence: string
  readonly auditGroupId: string
  readonly phase: typeof AuditPhase.Type
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly turnId: string
  readonly actor: ActorAttributionValue
  readonly decisionActor: ActorAttributionValue | null
  readonly policy: ToolPolicy
  readonly authorizationId: string | null
  readonly authorizationCheckpoint: AuditCheckpoint | null
  readonly module: string
  readonly operation: string
  readonly operationKey: string
  readonly callId: string
  readonly argumentsDigest: string
  readonly workspaceId: WorkspaceId
  readonly repository: AuditRepository | null
  readonly branch: string | null
  readonly executor: AuditExecutor
  readonly decision: AuditDecision
  readonly outcome: AuditOutcome
  readonly occurredAt: string
}

export interface AuditAppend {
  readonly auditGroupId: string
  readonly phase: typeof AuditPhase.Type
  readonly ownerId: OwnerId
  readonly threadId: ThreadId
  readonly turnId: string
  readonly actor: ActorAttributionValue
  readonly decisionActor?: ActorAttributionValue
  readonly policy: ToolPolicy
  readonly authorizationId?: string
  readonly authorizationCheckpoint?: AuditCheckpoint
  readonly module: string
  readonly operation: string
  readonly operationKey: string
  readonly callId: string
  readonly argumentsDigest: string
  readonly workspaceId: WorkspaceId
  readonly repository: AuditRepository | null
  readonly branch: string | null
  readonly executor: AuditExecutor
  readonly decision: AuditDecision
  readonly outcome: AuditOutcome
}

export interface AdmissionFence {
  readonly assignmentId: ExecutorAssignmentId
  readonly target: "runner" | "orb"
  readonly generation: number
  readonly leaseEpoch: number
  readonly providerInstanceId: string
  readonly executorInstanceId: ExecutorInstanceId
  readonly processIncarnation: string
}

export interface AdmissionContext {
  readonly ownerId: OwnerId
  readonly actor: ActorAttributionValue
  readonly executorKind: "runner" | "orb"
  readonly repositoryIdentity: string | null
  readonly branch: string | null
}

export interface DecisionAppend {
  readonly record: AuditAppend & { readonly phase: "decision"; readonly authorizationId: string }
  readonly expectedProjector: {
    readonly version: number
    readonly runId: string
    readonly approvalId: string
  }
}

export class ToolPolicyStoreError extends Schema.TaggedError<ToolPolicyStoreError>()("ToolPolicyStoreError", {
  kind: Schema.Literals(["unavailable", "conflict"]),
  message: Schema.String,
}) {}

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
  readonly appendDecision: (input: DecisionAppend) => Effect.Effect<"inserted" | "same" | "conflict", ToolPolicyStoreError>
  readonly resolveOwner: (input: {
    readonly principalUserId: BetterAuthUserIdValue
    readonly owner: HostedOwner
  }) => Effect.Effect<OwnerId | undefined, ToolPolicyStoreError>
  readonly listInspectionRecords: (input: {
    readonly ownerId: OwnerId
    readonly principalUserId: BetterAuthUserIdValue
    readonly limit: number
  }) => Effect.Effect<ReadonlyArray<AuditRecord>, ToolPolicyStoreError>
}

export class ToolPolicyStore extends Context.Service<ToolPolicyStore, ToolPolicyStoreService>()(
  "@rika/product-store/hosted/execution/tool-policy/ToolPolicyStore",
) {}

const failure = (cause: unknown) =>
  ToolPolicyStoreError.make({ kind: "unavailable", message: `Tool policy store is unavailable: ${String(cause)}` })
const query = <A extends object, E, R>(value: Effect.Effect<ReadonlyArray<A>, E, R>) => value.pipe(Effect.mapError(failure))
const decoded = <A, E, R>(value: Effect.Effect<A, E, R>) => value.pipe(Effect.mapError(failure))

const values = (record: AuditAppend) => ({
  auditGroupId: record.auditGroupId,
  phase: record.phase,
  ownerId: record.ownerId,
  threadId: record.threadId,
  turnId: record.turnId,
  actor: record.actor,
  decisionActor: record.decisionActor ?? null,
  policyId: record.policy.id,
  policyVersion: record.policy.version,
  capability: record.policy.capability,
  capabilities: record.policy.capabilities,
  sideEffect: record.policy.sideEffect,
  approval: record.policy.approval,
  replayPolicy: record.policy.replayPolicy,
  authorizationId: record.authorizationId ?? null,
  authorizationCheckpoint: record.authorizationCheckpoint ?? null,
  module: record.module,
  operation: record.operation,
  operationKey: record.operationKey,
  callId: record.callId,
  argumentsDigest: record.argumentsDigest,
  workspaceId: record.workspaceId,
  repository: record.repository,
  branch: record.branch,
  executor: record.executor,
  decision: record.decision,
  outcome: record.outcome,
})

type AuditRow = typeof rikaHostedToolAuditRecords.$inferSelect

const decodeRecord = (row: AuditRow): Effect.Effect<AuditRecord, ToolPolicyStoreError> =>
  Effect.gen(function* () {
    const phase = yield* decoded(Schema.decodeUnknownEffect(AuditPhase)(row.phase))
    const ownerId = yield* decoded(Schema.decodeEffect(OwnerId)(row.ownerId))
    const threadId = yield* decoded(Schema.decodeEffect(ThreadId)(row.threadId))
    const workspaceId = yield* decoded(Schema.decodeEffect(WorkspaceId)(row.workspaceId))
    const actor = yield* decoded(Schema.decodeUnknownEffect(ActorAttribution)(row.actor))
    const decisionActor = row.decisionActor === null ? null : yield* decoded(Schema.decodeUnknownEffect(ActorAttribution)(row.decisionActor))
    const capabilities = yield* decoded(Schema.decodeUnknownEffect(Schema.Array(Schema.NonEmptyString))(row.capabilities))
    const authorizationCheckpoint = row.authorizationCheckpoint === null
      ? null
      : yield* decoded(Schema.decodeUnknownEffect(AuditCheckpoint)(row.authorizationCheckpoint))
    const repository = row.repository === null ? null : yield* decoded(Schema.decodeUnknownEffect(AuditRepository)(row.repository))
    const executor = yield* decoded(Schema.decodeUnknownEffect(AuditExecutor)(row.executor))
    const decision = yield* decoded(Schema.decodeUnknownEffect(AuditDecision)(row.decision))
    const outcome = yield* decoded(Schema.decodeUnknownEffect(AuditOutcome)(row.outcome))
    return {
      sequence: String(row.sequence), auditGroupId: row.auditGroupId, phase, ownerId, threadId, turnId: row.turnId,
      actor, decisionActor,
      policy: { id: row.policyId, version: row.policyVersion, capability: row.capability, capabilities,
        sideEffect: row.sideEffect, approval: row.approval, replayPolicy: row.replayPolicy },
      authorizationId: row.authorizationId, authorizationCheckpoint, module: row.module, operation: row.operation,
      operationKey: row.operationKey, callId: row.callId, argumentsDigest: row.argumentsDigest, workspaceId,
      repository, branch: row.branch, executor, decision, outcome, occurredAt: row.occurredAt.toISOString(),
    }
  })

const sameDecision = (left: AuditRecord, right: AuditAppend) =>
  JSON.stringify(left.decisionActor) === JSON.stringify(right.decisionActor ?? null) &&
  JSON.stringify(left.authorizationCheckpoint) === JSON.stringify(right.authorizationCheckpoint ?? null) &&
  left.authorizationId === (right.authorizationId ?? null) && left.decision === right.decision && left.outcome === right.outcome

export const make = Effect.gen(function* () {
  const db = yield* PgDrizzle.makeWithDefaults()
  const insertAudit: ToolPolicyStoreService["insertAudit"] = (record) =>
    query(db.insert(rikaHostedToolAuditRecords).values(values(record)).returning({ sequence: rikaHostedToolAuditRecords.sequence })).pipe(Effect.asVoid)

  const loadAdmissionContext: ToolPolicyStoreService["loadAdmissionContext"] = (input) => {
    const legacy = db.$with("legacy").as(db.select({ actor: rikaHostedThreadCommands.actor }).from(rikaHostedThreadCommands)
      .where(and(eq(rikaHostedThreadCommands.threadId, input.threadId), eq(rikaHostedThreadCommands.turnId, input.turnId))).limit(1))
    const protocol = db.$with("protocol").as(db.select({ actor: rikaHostedThreadProtocolCommands.actor }).from(rikaHostedThreadProtocolCommands)
      .where(and(eq(rikaHostedThreadProtocolCommands.threadId, input.threadId), eq(rikaHostedThreadProtocolCommands.commandId, input.turnId),
        eq(sql<string>`${rikaHostedThreadProtocolCommands.command} ->> '_tag'`, "SubmitPrompt"))).limit(1))
    const actor = sql<Schema.Json>`coalesce(${legacy.actor}, ${protocol.actor})`
    const userId = sql<string>`${actor} ->> 'userId'`
    const clientId = sql<string>`${actor} ->> 'clientId'`
    const deviceId = sql<string>`${actor} ->> 'deviceId'`
    const membershipId = sql<string>`${actor} ->> 'membershipId'`
    return query(db.with(legacy, protocol).select({
      ownerId: rikaHostedThreads.ownerId,
      actor,
      executorKind: rikaHostedExecutorAssignments.executorKind,
      repositoryIdentity: sql<string | null>`case when ${rikaHostedExecutorAssignments.executorKind} = 'runner' then ${rikaHostedRunnerRegistrations.repository} ->> 'identity' when ${rikaHostedExecutorAssignments.checkout} is not null then ${rikaHostedExecutorAssignments.checkout} ->> 'repositoryId' else null end`,
      branch: sql<string | null>`case when ${rikaHostedExecutorAssignments.executorKind} = 'runner' then coalesce(${rikaHostedRunnerRegistrations.repository} ->> 'branch', case when ${rikaHostedRunnerRegistrations.repository} ? 'headRevision' then concat('detached:', ${rikaHostedRunnerRegistrations.repository} ->> 'headRevision') end) when ${rikaHostedExecutorAssignments.checkout} is not null then concat('detached:', ${rikaHostedExecutorAssignments.checkout} ->> 'commitSha') else null end`,
    }).from(rikaHostedThreads)
      .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedThreads.ownerId))
      .innerJoin(rikaHostedWorkspaces, and(eq(rikaHostedWorkspaces.id, rikaHostedThreads.workspaceId), eq(rikaHostedWorkspaces.ownerId, rikaHostedThreads.ownerId)))
      .innerJoin(rikaHostedExecutorAssignments, and(eq(rikaHostedExecutorAssignments.threadId, rikaHostedThreads.id), eq(rikaHostedExecutorAssignments.ownerId, rikaHostedThreads.ownerId)))
      .leftJoin(rikaHostedRunnerRegistrations, and(eq(rikaHostedRunnerRegistrations.deviceId, sql`${rikaHostedExecutorAssignments.placement} ->> 'deviceId'`), eq(rikaHostedRunnerRegistrations.checkoutFingerprint, sql`${rikaHostedExecutorAssignments.placement} ->> 'checkoutFingerprint'`)))
      .leftJoin(legacy, sql`true`).leftJoin(protocol, sql`true`)
      .innerJoin(rikaHostedClients, and(eq(rikaHostedClients.id, clientId), eq(rikaHostedClients.userId, userId), isNull(rikaHostedClients.revokedAt), gt(rikaHostedClients.expiresAt, sql`clock_timestamp()`)))
      .innerJoin(rikaHostedClientAuthorities, and(eq(rikaHostedClientAuthorities.clientId, rikaHostedClients.id), eq(rikaHostedClientAuthorities.ownerId, rikaHostedThreads.ownerId), isNull(rikaHostedClientAuthorities.revokedAt), gt(rikaHostedClientAuthorities.expiresAt, sql`clock_timestamp()`)))
      .innerJoin(rikaHostedDevices, and(eq(rikaHostedDevices.id, deviceId), eq(rikaHostedDevices.userId, userId), isNull(rikaHostedDevices.revokedAt)))
      .leftJoin(identityMember, and(eq(identityMember.id, membershipId), eq(identityMember.organizationId, rikaHostedOwners.organizationId), eq(identityMember.userId, userId)))
      .leftJoin(rikaHostedThreadGrants, and(eq(rikaHostedThreadGrants.ownerId, rikaHostedThreads.ownerId), eq(rikaHostedThreadGrants.threadId, rikaHostedThreads.id), eq(rikaHostedThreadGrants.membershipId, identityMember.id)))
      .leftJoin(rikaHostedProjectGrants, and(eq(rikaHostedProjectGrants.ownerId, rikaHostedThreads.ownerId), eq(rikaHostedProjectGrants.projectId, rikaHostedThreads.projectId), eq(rikaHostedProjectGrants.membershipId, identityMember.id)))
      .where(and(eq(rikaHostedThreads.id, input.threadId), eq(rikaHostedWorkspaces.id, input.workspaceId),
        eq(rikaHostedExecutorAssignments.id, input.fence.assignmentId), eq(rikaHostedExecutorAssignments.executorKind, input.fence.target),
        eq(rikaHostedExecutorAssignments.generation, input.fence.generation), eq(rikaHostedExecutorAssignments.leaseEpoch, input.fence.leaseEpoch),
        eq(rikaHostedExecutorAssignments.providerInstanceId, input.fence.providerInstanceId), eq(rikaHostedExecutorAssignments.executorInstanceId, input.fence.executorInstanceId),
        eq(rikaHostedExecutorAssignments.processIncarnation, input.fence.processIncarnation), eq(rikaHostedExecutorAssignments.lifecycle, "active"),
        gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`), isNotNull(actor),
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
      )).limit(1)).pipe(
      Effect.flatMap((rows) => Effect.gen(function* () {
        const row = rows[0]
        if (row === undefined) return undefined
        return { ownerId: yield* decoded(Schema.decodeEffect(OwnerId)(row.ownerId)), actor: yield* decoded(Schema.decodeUnknownEffect(ActorAttribution)(row.actor)),
          executorKind: row.executorKind, repositoryIdentity: row.repositoryIdentity, branch: row.branch }
      })))
  }

  const listAuthorizationRecords: ToolPolicyStoreService["listAuthorizationRecords"] = (input) =>
    query(db.select().from(rikaHostedToolAuditRecords).where(and(eq(rikaHostedToolAuditRecords.ownerId, input.ownerId),
      eq(rikaHostedToolAuditRecords.threadId, input.threadId), eq(rikaHostedToolAuditRecords.turnId, input.turnId),
      eq(rikaHostedToolAuditRecords.phase, "outcome"), eq(rikaHostedToolAuditRecords.outcome, "suspended"),
      eq(rikaHostedToolAuditRecords.authorizationId, input.authorizationId))).orderBy(desc(rikaHostedToolAuditRecords.sequence))).pipe(Effect.flatMap((rows) => Effect.forEach(rows, decodeRecord)))

  const appendDecision: ToolPolicyStoreService["appendDecision"] = (input) => db.transaction((tx) => Effect.gen(function* () {
    const existing = yield* query(tx.select().from(rikaHostedToolAuditRecords).where(and(eq(rikaHostedToolAuditRecords.auditGroupId, input.record.auditGroupId), eq(rikaHostedToolAuditRecords.phase, "decision"))).limit(1))
    if (existing[0] !== undefined) return sameDecision(yield* decodeRecord(existing[0]), input.record) ? "same" : "conflict"
    const checkpoint = yield* query(tx.select({ turnId: rikaTranscriptCheckpoints.turnId }).from(rikaTranscriptCheckpoints).where(and(
      eq(rikaTranscriptCheckpoints.turnId, input.record.turnId),
      eq(rikaTranscriptCheckpoints.projectorVersion, input.expectedProjector.version),
      sql<boolean>`exists (
        select 1
        from jsonb_array_elements((${rikaTranscriptCheckpoints.projectorState})::jsonb -> 'authorizations') as projected_entry
        where projected_entry ->> 0 = ${input.record.authorizationId}
          and projected_entry -> 1 ->> 'rawRunId' = ${input.expectedProjector.runId}
          and projected_entry -> 1 ->> 'approvalId' = ${input.expectedProjector.approvalId}
      )`,
    )).limit(1))
    const executor = input.record.executor
    const fence = yield* query(tx.select({ id: rikaHostedExecutorAssignments.id }).from(rikaHostedExecutorAssignments).where(and(
      eq(rikaHostedExecutorAssignments.id, executor.assignmentId), eq(rikaHostedExecutorAssignments.ownerId, input.record.ownerId),
      eq(rikaHostedExecutorAssignments.threadId, input.record.threadId), eq(rikaHostedExecutorAssignments.executorKind, executor.kind),
      eq(rikaHostedExecutorAssignments.generation, executor.generation), eq(rikaHostedExecutorAssignments.leaseEpoch, executor.leaseEpoch),
      eq(rikaHostedExecutorAssignments.providerInstanceId, executor.instanceId), eq(rikaHostedExecutorAssignments.executorInstanceId, executor.executorId),
      eq(rikaHostedExecutorAssignments.processIncarnation, executor.processIncarnation), eq(rikaHostedExecutorAssignments.lifecycle, "active"),
      gt(rikaHostedExecutorAssignments.leaseExpiresAt, sql`clock_timestamp()`))).limit(1))
    if (checkpoint[0] === undefined || fence[0] === undefined) return "conflict"
    yield* query(tx.insert(rikaHostedToolAuditRecords).values(values(input.record)).onConflictDoNothing({ target: rikaHostedToolAuditRecords.auditGroupId, where: sql`${rikaHostedToolAuditRecords.phase} = 'decision'` }).returning({ sequence: rikaHostedToolAuditRecords.sequence }))
    const stored = yield* query(tx.select().from(rikaHostedToolAuditRecords).where(and(eq(rikaHostedToolAuditRecords.auditGroupId, input.record.auditGroupId), eq(rikaHostedToolAuditRecords.phase, "decision"))).limit(1))
    return stored[0] !== undefined && sameDecision(yield* decodeRecord(stored[0]), input.record) ? "inserted" : "conflict"
  })).pipe(Effect.mapError(failure))

  const resolveOwner: ToolPolicyStoreService["resolveOwner"] = (input) => query(db.select({ id: rikaHostedOwners.id }).from(rikaHostedOwners).where(or(
    and(eq(rikaHostedOwners.kind, "personal"), eq(rikaHostedOwners.userId, input.owner._tag === "PersonalOwner" ? input.owner.userId : ""), eq(rikaHostedOwners.userId, input.principalUserId)),
    and(eq(rikaHostedOwners.kind, "organization"), eq(rikaHostedOwners.organizationId, input.owner._tag === "OrganizationOwner" ? input.owner.organizationId : ""),
      sql<boolean>`exists (select 1 from "member" m where m.organization_id = ${rikaHostedOwners.organizationId} and m.user_id = ${input.principalUserId})`))).limit(1)).pipe(
        Effect.flatMap((rows) => Effect.gen(function* () {
          const row = rows[0]
          if (row === undefined) return undefined
          return yield* decoded(Schema.decodeEffect(OwnerId)(row.id))
        })))

  const listInspectionRecords: ToolPolicyStoreService["listInspectionRecords"] = (input) => query(db.select({ record: rikaHostedToolAuditRecords }).from(rikaHostedToolAuditRecords)
    .innerJoin(rikaHostedThreads, and(eq(rikaHostedThreads.id, rikaHostedToolAuditRecords.threadId), eq(rikaHostedThreads.ownerId, rikaHostedToolAuditRecords.ownerId)))
    .innerJoin(rikaHostedOwners, eq(rikaHostedOwners.id, rikaHostedToolAuditRecords.ownerId))
    .where(and(eq(rikaHostedToolAuditRecords.ownerId, input.ownerId), or(eq(rikaHostedOwners.kind, "personal"),
      sql<boolean>`exists (select 1 from "member" m where m.organization_id = ${rikaHostedOwners.organizationId} and m.user_id = ${input.principalUserId} and (m.role in ('owner', 'admin') or ${rikaHostedThreads.createdByUserId} = ${input.principalUserId} or exists (select 1 from rika_hosted_thread_grants g where g.owner_id = ${rikaHostedThreads.ownerId} and g.thread_id = ${rikaHostedThreads.id} and g.membership_id = m.id) or (${rikaHostedThreads.executorKind} = 'orb' and ${rikaHostedThreads.inheritProjectGrants} and exists (select 1 from rika_hosted_project_grants g where g.owner_id = ${rikaHostedThreads.ownerId} and g.project_id = ${rikaHostedThreads.projectId} and g.membership_id = m.id))))`)))
    .orderBy(desc(rikaHostedToolAuditRecords.sequence)).limit(Math.min(Math.max(input.limit, 1), 500))).pipe(Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeRecord(row.record))))

  return ToolPolicyStore.of({ insertAudit, loadAdmissionContext, listAuthorizationRecords, appendDecision, resolveOwner, listInspectionRecords })
})

export const layer = Layer.effect(ToolPolicyStore, make)
