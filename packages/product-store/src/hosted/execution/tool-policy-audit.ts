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
import { Effect, Schema } from "effect"
import { rikaHostedToolAuditRecords } from "../../database/schema/product"

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

export interface ResolveOwnerInput {
  readonly principalUserId: BetterAuthUserIdValue
  readonly owner: HostedOwner
}

export class ToolPolicyStoreError extends Schema.TaggedError<ToolPolicyStoreError>()("ToolPolicyStoreError", {
  kind: Schema.Literals(["unavailable", "conflict"]),
  message: Schema.String,
}) {}

export const failure = (cause: unknown) =>
  ToolPolicyStoreError.make({ kind: "unavailable", message: `Tool policy store is unavailable: ${String(cause)}` })

const decoded = <A, E, R>(value: Effect.Effect<A, E, R>) => value.pipe(Effect.mapError(failure))

export const auditValues = (record: AuditAppend) => ({
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

export const decodeAuditRecord = (row: AuditRow): Effect.Effect<AuditRecord, ToolPolicyStoreError> =>
  Effect.gen(function* () {
    const phase = yield* decoded(Schema.decodeUnknownEffect(AuditPhase)(row.phase))
    const ownerId = yield* decoded(Schema.decodeEffect(OwnerId)(row.ownerId))
    const threadId = yield* decoded(Schema.decodeEffect(ThreadId)(row.threadId))
    const workspaceId = yield* decoded(Schema.decodeEffect(WorkspaceId)(row.workspaceId))
    const actor = yield* decoded(Schema.decodeUnknownEffect(ActorAttribution)(row.actor))
    const decisionActor =
      row.decisionActor === null
        ? null
        : yield* decoded(Schema.decodeUnknownEffect(ActorAttribution)(row.decisionActor))
    const capabilities = yield* decoded(
      Schema.decodeUnknownEffect(Schema.Array(Schema.NonEmptyString))(row.capabilities),
    )
    const authorizationCheckpoint =
      row.authorizationCheckpoint === null
        ? null
        : yield* decoded(Schema.decodeUnknownEffect(AuditCheckpoint)(row.authorizationCheckpoint))
    const repository =
      row.repository === null ? null : yield* decoded(Schema.decodeUnknownEffect(AuditRepository)(row.repository))
    const executor = yield* decoded(Schema.decodeUnknownEffect(AuditExecutor)(row.executor))
    const decision = yield* decoded(Schema.decodeUnknownEffect(AuditDecision)(row.decision))
    const outcome = yield* decoded(Schema.decodeUnknownEffect(AuditOutcome)(row.outcome))
    return {
      sequence: String(row.sequence),
      auditGroupId: row.auditGroupId,
      phase,
      ownerId,
      threadId,
      turnId: row.turnId,
      actor,
      decisionActor,
      policy: {
        id: row.policyId,
        version: row.policyVersion,
        capability: row.capability,
        capabilities,
        sideEffect: row.sideEffect,
        approval: row.approval,
        replayPolicy: row.replayPolicy,
      },
      authorizationId: row.authorizationId,
      authorizationCheckpoint,
      module: row.module,
      operation: row.operation,
      operationKey: row.operationKey,
      callId: row.callId,
      argumentsDigest: row.argumentsDigest,
      workspaceId,
      repository,
      branch: row.branch,
      executor,
      decision,
      outcome,
      occurredAt: row.occurredAt.toISOString(),
    }
  })

export const sameDecision = (right: AuditAppend) => (left: AuditRecord) =>
  JSON.stringify(left.decisionActor) === JSON.stringify(right.decisionActor ?? null) &&
  JSON.stringify(left.authorizationCheckpoint) === JSON.stringify(right.authorizationCheckpoint ?? null) &&
  left.authorizationId === (right.authorizationId ?? null) &&
  left.decision === right.decision &&
  left.outcome === right.outcome
