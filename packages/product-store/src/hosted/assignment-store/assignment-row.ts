import { Effect, Schema } from "effect"
import { sql as expression } from "drizzle-orm"
import { ExecutorAssignment, WorkspaceCheckpointManifest } from "@rika/product/executor-assignment"
import { AssignmentError } from "@rika/product/executor-assignments"
import { rikaHostedCheckpoints, rikaHostedExecutorAssignments } from "../../database/schema/product"

export const assignmentFields = {
  id: rikaHostedExecutorAssignments.id,
  ownerId: rikaHostedExecutorAssignments.ownerId,
  threadId: rikaHostedExecutorAssignments.threadId,
  workspaceId: rikaHostedExecutorAssignments.workspaceId,
  executorKind: rikaHostedExecutorAssignments.executorKind,
  placement: rikaHostedExecutorAssignments.placement,
  checkout: rikaHostedExecutorAssignments.checkout,
  workspaceSeed: rikaHostedExecutorAssignments.workspaceSeed,
  generation: rikaHostedExecutorAssignments.generation,
  revision: rikaHostedExecutorAssignments.revision,
  lastLeaseEpoch: rikaHostedExecutorAssignments.lastLeaseEpoch,
  lifecycle: rikaHostedExecutorAssignments.lifecycle,
  capabilityGeneration: rikaHostedExecutorAssignments.capabilityGeneration,
  capabilitySnapshot: rikaHostedExecutorAssignments.capabilitySnapshot,
  providerInstanceId: rikaHostedExecutorAssignments.providerInstanceId,
  bootstrapDigest: rikaHostedExecutorAssignments.bootstrapDigest,
  bootstrapExpiresAt: rikaHostedExecutorAssignments.bootstrapExpiresAt,
  bootstrapLive: expression<boolean>`coalesce(${rikaHostedExecutorAssignments.bootstrapExpiresAt} > clock_timestamp(), false)`,
  executorInstanceId: rikaHostedExecutorAssignments.executorInstanceId,
  processIncarnation: rikaHostedExecutorAssignments.processIncarnation,
  sessionDigest: rikaHostedExecutorAssignments.sessionDigest,
  leaseEpoch: rikaHostedExecutorAssignments.leaseEpoch,
  leaseExpiresAt: rikaHostedExecutorAssignments.leaseExpiresAt,
  leaseLive: expression<boolean>`coalesce(${rikaHostedExecutorAssignments.leaseExpiresAt} > clock_timestamp(), false)`,
  cursorSequence: rikaHostedExecutorAssignments.cursorSequence,
  cursorValue: rikaHostedExecutorAssignments.cursorValue,
  latestCheckpointId: rikaHostedExecutorAssignments.latestCheckpointId,
  lastActiveAt: rikaHostedExecutorAssignments.lastActiveAt,
  createdAt: rikaHostedExecutorAssignments.createdAt,
  updatedAt: rikaHostedExecutorAssignments.updatedAt,
}

type AssignmentRecord = typeof rikaHostedExecutorAssignments.$inferSelect
export type AssignmentRow = Omit<
  AssignmentRecord,
  | "bootstrapDigest"
  | "capabilitySnapshot"
  | "sessionDigest"
  | "generation"
  | "revision"
  | "lastLeaseEpoch"
  | "capabilityGeneration"
  | "leaseEpoch"
  | "cursorSequence"
  | "bootstrapExpiresAt"
  | "leaseExpiresAt"
  | "lastActiveAt"
  | "createdAt"
  | "updatedAt"
> & {
  readonly generation: string
  readonly revision: string
  readonly lastLeaseEpoch: string
  readonly capabilityGeneration: string | null
  readonly capabilities: unknown
  readonly bootstrapCredentialDigest: string | null
  readonly bootstrapExpiresAt: string | null
  readonly bootstrapLive: boolean
  readonly sessionCredentialDigest: string | null
  readonly leaseEpoch: string | null
  readonly leaseExpiresAt: string | null
  readonly leaseLive: boolean
  readonly cursorSequence: string
  readonly lastActiveAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

type CheckpointRecord = typeof rikaHostedCheckpoints.$inferSelect
export type CheckpointRow = Omit<
  CheckpointRecord,
  "assignmentGeneration" | "leaseEpoch" | "cursorSequence" | "verifiedAt"
> & {
  readonly assignmentGeneration: string
  readonly leaseEpoch: string
  readonly cursorSequence: string
  readonly verifiedAt: string
}

export const databaseError = (cause: unknown) =>
  Schema.is(AssignmentError)(cause)
    ? cause
    : AssignmentError.make({
        reason: "database",
        message: `Executor assignment database operation failed: ${String(cause)}`,
      })

const timestamp = (value: Date | null) => (value === null ? null : value.toISOString())

export const assignmentRow = (
  row: AssignmentRecord & { readonly bootstrapLive: boolean; readonly leaseLive: boolean },
): AssignmentRow => ({
  ...row,
  generation: String(row.generation),
  revision: String(row.revision),
  lastLeaseEpoch: String(row.lastLeaseEpoch),
  capabilityGeneration: row.capabilityGeneration === null ? null : String(row.capabilityGeneration),
  capabilities: row.capabilitySnapshot,
  bootstrapCredentialDigest: row.bootstrapDigest,
  bootstrapExpiresAt: timestamp(row.bootstrapExpiresAt),
  leaseEpoch: row.leaseEpoch === null ? null : String(row.leaseEpoch),
  sessionCredentialDigest: row.sessionDigest,
  leaseExpiresAt: timestamp(row.leaseExpiresAt),
  cursorSequence: String(row.cursorSequence),
  lastActiveAt: row.lastActiveAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
})

export const checkpointRow = (row: CheckpointRecord): CheckpointRow => ({
  ...row,
  assignmentGeneration: String(row.assignmentGeneration),
  leaseEpoch: String(row.leaseEpoch),
  cursorSequence: String(row.cursorSequence),
  verifiedAt: row.verifiedAt.toISOString(),
})

const lifecycle = (row: AssignmentRow) => {
  switch (row.lifecycle) {
    case "pending":
      return { _tag: "Pending" }
    case "provisioning":
      return {
        _tag: "Provisioning",
        providerInstanceId: row.providerInstanceId,
        bootstrapExpiresAt: row.bootstrapExpiresAt,
      }
    case "awaiting_bootstrap":
      return {
        _tag: "AwaitingBootstrap",
        providerInstanceId: row.providerInstanceId,
        bootstrapExpiresAt: row.bootstrapExpiresAt,
      }
    case "active":
      return {
        _tag: "Active",
        providerInstanceId: row.providerInstanceId,
        executorInstanceId: row.executorInstanceId,
        processIncarnation: row.processIncarnation,
        leaseEpoch: row.leaseEpoch,
        leaseExpiresAt: row.leaseExpiresAt,
      }
    case "paused":
      return { _tag: "Paused", providerInstanceId: row.providerInstanceId }
    case "terminated":
      return { _tag: "Terminated" }
  }
}

export const decodeAssignment = (row: AssignmentRow) =>
  Schema.decodeUnknownEffect(ExecutorAssignment)({
    id: row.id,
    ownerId: row.ownerId,
    threadId: row.threadId,
    workspaceId: row.workspaceId,
    executorKind: row.executorKind,
    placement: row.placement,
    checkout: row.checkout,
    workspaceSeed: row.workspaceSeed,
    generation: row.generation,
    revision: row.revision,
    lastLeaseEpoch: row.lastLeaseEpoch,
    lifecycle: lifecycle(row),
    capabilityGeneration: row.capabilityGeneration,
    capabilities: row.capabilities,
    cursor: { sequence: row.cursorSequence, value: row.cursorValue },
    latestCheckpointId: row.latestCheckpointId,
    lastActiveAt: row.lastActiveAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }).pipe(Effect.mapError(databaseError))

export const decodeCheckpoint = (row: CheckpointRow) =>
  Schema.decodeUnknownEffect(WorkspaceCheckpointManifest)({
    id: row.id,
    ownerId: row.ownerId,
    threadId: row.threadId,
    assignmentId: row.assignmentId,
    executorInstanceId: row.executorInstanceId,
    assignmentGeneration: row.assignmentGeneration,
    leaseEpoch: row.leaseEpoch,
    objectKey: row.objectKey,
    contentDigest: row.contentDigest,
    sizeBytes: row.sizeBytes,
    format: row.format,
    cursor: { sequence: row.cursorSequence, value: row.cursorValue },
    metadata: row.metadata,
    verifiedAt: row.verifiedAt,
  }).pipe(Effect.mapError(databaseError))
