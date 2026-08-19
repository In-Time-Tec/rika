import { Context, Effect, type Redacted, Schema } from "effect"
import type {
  AssignmentRevision,
  ExecutorAssignment,
  ExecutorCursor,
  ExecutorPlacement,
  RepositoryCheckout,
  WorkspaceCheckpointManifest,
} from "./executor-assignment"
import type {
  AssignmentLeaseEpoch,
  CheckpointId,
  ExecutorAssignmentId,
  ExecutorInstanceId,
  FencingGeneration,
  JsonObject,
  OrganizationId,
  ThreadId,
} from "./model"

export const AssignmentFailureReason = Schema.Literals([
  "authentication",
  "conflict",
  "database",
  "invalid-authority",
  "invalid-state",
  "not-found",
  "stale-fence",
])
export type AssignmentFailureReason = typeof AssignmentFailureReason.Type

export class AssignmentError extends Schema.TaggedError<AssignmentError>()(
  "AssignmentError",
  {
    reason: AssignmentFailureReason,
    message: Schema.String,
  },
) {}

export interface CreateInput {
  readonly id: ExecutorAssignmentId
  readonly organizationId: OrganizationId
  readonly threadId: ThreadId
  readonly placement: ExecutorPlacement
  readonly checkout: RepositoryCheckout | null
}

export interface Version {
  readonly assignmentId: ExecutorAssignmentId
  readonly generation: FencingGeneration
  readonly revision: AssignmentRevision
}

export interface BeginProvisioningInput extends Version {
  readonly bootstrapCredentialDigest: Redacted.Redacted<string>
  readonly bootstrapLifetimeMillis: number
}

export interface BeginReplacementInput extends Version {
  readonly bootstrapCredentialDigest: Redacted.Redacted<string>
  readonly bootstrapLifetimeMillis: number
}

export interface BindProviderInstanceInput extends Version {
  readonly providerInstanceId: string
}

export interface OpenSessionInput extends Version {
  readonly providerInstanceId: string
  readonly executorInstanceId: ExecutorInstanceId
  readonly processIncarnation: string
  readonly presentedBootstrapCredentialDigest: Redacted.Redacted<string>
  readonly sessionCredentialDigest: Redacted.Redacted<string>
  readonly leaseLifetimeMillis: number
}

export interface Fence {
  readonly assignmentId: ExecutorAssignmentId
  readonly assignmentGeneration: FencingGeneration
  readonly leaseEpoch: AssignmentLeaseEpoch
}

export interface Access extends Fence {
  readonly providerInstanceId: string
  readonly executorInstanceId: ExecutorInstanceId
  readonly processIncarnation: string
  readonly presentedSessionCredentialDigest: Redacted.Redacted<string>
}

export interface ReconnectInput {
  readonly access: Access
  readonly leaseLifetimeMillis: number
}

export interface HeartbeatInput extends ReconnectInput {
  readonly cursor: ExecutorCursor
}

export interface PauseInput {
  readonly assignmentId: ExecutorAssignmentId
  readonly generation: FencingGeneration
  readonly revision: AssignmentRevision
}

export interface ResumeInput extends Version {
  readonly bootstrapCredentialDigest: Redacted.Redacted<string>
  readonly bootstrapLifetimeMillis: number
}

export interface TerminateInput extends Version {}

export interface CommitCheckpointInput {
  readonly access: Access
  readonly id: CheckpointId
  readonly objectKey: string
  readonly contentDigest: string
  readonly sizeBytes: number
  readonly format: "tar.zst"
  readonly cursor: ExecutorCursor
  readonly metadata: JsonObject
}

export interface AssignmentsService {
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly get: (
    assignmentId: ExecutorAssignmentId,
  ) => Effect.Effect<ExecutorAssignment | undefined, AssignmentError>
  readonly beginProvisioning: (
    input: BeginProvisioningInput,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly beginReplacement: (
    input: BeginReplacementInput,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly bindProviderInstance: (
    input: BindProviderInstanceInput,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly openSession: (
    input: OpenSessionInput,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly reconnect: (
    input: ReconnectInput,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly heartbeat: (
    input: HeartbeatInput,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly authenticate: (
    access: Access,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly validateFence: (
    fence: Fence,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly pause: (
    input: PauseInput,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly resume: (
    input: ResumeInput,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly terminate: (
    input: TerminateInput,
  ) => Effect.Effect<ExecutorAssignment, AssignmentError>
  readonly commitCheckpoint: (
    input: CommitCheckpointInput,
  ) => Effect.Effect<WorkspaceCheckpointManifest, AssignmentError>
  readonly listManaged: Effect.Effect<ReadonlyArray<ExecutorAssignment>, AssignmentError>
}

export class ExecutorAssignments extends Context.Service<ExecutorAssignments, AssignmentsService>()(
  "@rika/product/hosted/executor-assignments/ExecutorAssignments",
) {}
