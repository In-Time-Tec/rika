import { Schema } from "effect"
import {
  Checkpoint,
  CheckpointId,
  EventId,
  ExecutorAssignmentLease,
  ExecutorInstance,
  ExecutorInstanceId,
  ExecutorKind,
  FencingGeneration,
  IdempotencyKey,
  JsonObject,
  LeaseId,
  OrganizationId,
  Sequence,
  ThreadEvent,
  ThreadId,
  Timestamp,
} from "../hosted-authority-model"

export const ExecutorToControlPlane = Schema.Union([
  Schema.TaggedStruct("RegisterExecutor", { executor: ExecutorInstance }),
  Schema.TaggedStruct("AcquireAssignment", {
    organizationId: OrganizationId,
    threadId: ThreadId,
    executorInstanceId: ExecutorInstanceId,
    executorKind: ExecutorKind,
    leaseId: LeaseId,
    now: Timestamp,
    expiresAt: Timestamp,
  }),
  Schema.TaggedStruct("RenewAssignment", {
    organizationId: OrganizationId,
    threadId: ThreadId,
    executorInstanceId: ExecutorInstanceId,
    leaseId: LeaseId,
    generation: FencingGeneration,
    now: Timestamp,
    expiresAt: Timestamp,
  }),
  Schema.TaggedStruct("AppendThreadEvent", {
    organizationId: OrganizationId,
    threadId: ThreadId,
    eventId: EventId,
    idempotencyKey: IdempotencyKey,
    executorInstanceId: ExecutorInstanceId,
    leaseId: LeaseId,
    assignmentGeneration: FencingGeneration,
    commandSequence: Schema.NullOr(Sequence),
    event: JsonObject,
    createdAt: Timestamp,
  }),
  Schema.TaggedStruct("SaveCheckpoint", {
    checkpointId: CheckpointId,
    organizationId: OrganizationId,
    threadId: ThreadId,
    executorInstanceId: ExecutorInstanceId,
    leaseId: LeaseId,
    assignmentGeneration: FencingGeneration,
    eventSequence: Sequence,
    batonCheckpointReference: Schema.NonEmptyString,
    metadata: JsonObject,
    createdAt: Timestamp,
  }),
])
export type ExecutorToControlPlane = typeof ExecutorToControlPlane.Type

export const ControlPlaneToExecutor = Schema.Union([
  Schema.TaggedStruct("ExecutorRegistered", { executor: ExecutorInstance }),
  Schema.TaggedStruct("AssignmentGranted", { assignment: ExecutorAssignmentLease }),
  Schema.TaggedStruct("AssignmentRenewed", { assignment: ExecutorAssignmentLease }),
  Schema.TaggedStruct("EventAppended", { event: ThreadEvent }),
  Schema.TaggedStruct("CheckpointStored", { checkpoint: Checkpoint }),
  Schema.TaggedStruct("Rejected", {
    reason: Schema.NonEmptyString,
    expectedGeneration: Schema.NullOr(FencingGeneration),
  }),
])
export type ControlPlaneToExecutor = typeof ControlPlaneToExecutor.Type
