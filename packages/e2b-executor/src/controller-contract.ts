import type { ExecutorAssignment, WorkspaceCapabilitySnapshot } from "@rika/product/executor-assignment"
import type { PhaseEgressPolicy } from "@rika/product/environment-policy"
import type {
  Access as ProtocolAccess,
  CheckpointProposal,
  Cursor,
  EncodedArchive,
  Fence,
  FilesystemCheckpoint,
  Heartbeat,
  Hello,
  QuiescedOperation,
  WorkspaceProof,
} from "@rika/remote-execution/protocol"
import { encodeArchive, type SetupCacheKey } from "@rika/remote-execution/workspace-archive"
import { Effect, Redacted, Schema } from "effect"
import type { Credential } from "./checkout"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const AssignmentKey = Schema.Struct({ assignmentId: Identifier, generation: Generation })
export type AssignmentKey = typeof AssignmentKey.Type

export interface Assignment {
  readonly assignmentId: string
  readonly threadId: string
  readonly generation: number
  readonly templateBuildId: string
  readonly sandboxId?: string
  readonly state: "provisioning" | "running" | "paused" | "terminated"
  readonly cursor: Cursor
}

export interface VerifiedCheckpoint {
  readonly assignmentId: string
  readonly generation: number
  readonly sandboxId: string
  readonly checkpoint: FilesystemCheckpoint
  readonly verifiedAt: number
}

export interface Quiescence {
  readonly access: ProtocolAccess
  readonly operations: ReadonlyArray<QuiescedOperation>
  readonly checkpoint: CheckpointProposal
}

export interface WorkspaceAuthorization {
  readonly egress: PhaseEgressPolicy
  readonly environmentDigest: string
}

export interface Welcome {
  readonly version: 1
  readonly fence: Fence
  readonly sessionToken: Redacted.Redacted<string>
  readonly leaseEpoch: number
  readonly leaseExpiresAt: number
  readonly heartbeatIntervalMillis: number
  readonly cursor: Cursor
}

export interface ReconnectWelcome {
  readonly version: 1
  readonly fence: Fence
  readonly leaseEpoch: number
  readonly leaseExpiresAt: number
  readonly heartbeatIntervalMillis: number
  readonly cursor: Cursor
}

export interface Receipt {
  readonly version: 1
  readonly fence: Fence
  readonly leaseEpoch: number
  readonly leaseExpiresAt: number
  readonly cursor: Cursor
}

export class ControllerError extends Schema.TaggedError<ControllerError>()("ControllerError", {
  kind: Schema.Literals([
    "assignment-conflict",
    "assignment-missing",
    "authentication",
    "checkpoint",
    "checkout",
    "fenced",
    "lease-expired",
    "provider",
    "protocol",
    "repository",
  ]),
  message: Schema.String,
}) {}

export const IdleTimeoutMillis = 15 * 60 * 1_000
export const DefaultHeartbeatIntervalMillis = 20_000
export const DefaultLeaseLifetimeMillis = 60_000
export const DefaultBootstrapLifetimeMillis = 5 * 60 * 1_000
export const DefaultOrphanGraceMillis = 5 * 60 * 1_000

export interface Options {
  readonly appId: string
  readonly deploymentId: string
  readonly templateId: string
  readonly templateBuildId: string
  readonly apiUrl: string
  readonly controlEgress: ReadonlyArray<string>
  readonly idleTimeoutMillis?: number
  readonly heartbeatIntervalMillis?: number
  readonly leaseLifetimeMillis?: number
  readonly bootstrapLifetimeMillis?: number
  readonly orphanGraceMillis?: number
  readonly setupCache?: boolean
}

export type CredentialCommand = {
  readonly ownerId: string
  readonly assignmentId: string
  readonly repositoryId: string
  readonly workspaceId: string
  readonly assignmentGeneration: number
  readonly leaseEpoch: number
} & (
  | { readonly purpose: "git-read" | "github-read" }
  | {
      readonly purpose: "branch-push"
      readonly publicationId: string
      readonly branch: string
      readonly ref: string
      readonly commitSha: string
    }
)

export interface Interface {
  readonly provision: (
    assignmentId: string,
    authorization: WorkspaceAuthorization,
  ) => Effect.Effect<Assignment, ControllerError>
  readonly replace: (
    key: AssignmentKey,
    authorization: WorkspaceAuthorization,
  ) => Effect.Effect<Assignment, ControllerError>
  readonly resume: (
    key: AssignmentKey,
    authorization: WorkspaceAuthorization,
  ) => Effect.Effect<Assignment, ControllerError>
  readonly pause: (key: AssignmentKey, quiescence?: Quiescence) => Effect.Effect<Assignment, ControllerError>
  readonly kill: (key: AssignmentKey) => Effect.Effect<Assignment, ControllerError>
  readonly portal: (key: AssignmentKey, port: number) => Effect.Effect<string, ControllerError>
  readonly hello: (hello: Hello) => Effect.Effect<Welcome, ControllerError>
  readonly reconnect: (access: ProtocolAccess) => Effect.Effect<ReconnectWelcome, ControllerError>
  readonly validateAccess: (access: ProtocolAccess) => Effect.Effect<void, ControllerError>
  readonly heartbeat: (heartbeat: Heartbeat) => Effect.Effect<Receipt, ControllerError>
  readonly checkpoint: (
    access: ProtocolAccess,
    checkpoint: CheckpointProposal,
  ) => Effect.Effect<VerifiedCheckpoint, ControllerError>
  readonly credential: (
    access: ProtocolAccess,
    request: CredentialCommand,
  ) => Effect.Effect<Credential, ControllerError>
  readonly revokeCredential: (
    access: ProtocolAccess,
    request: CredentialCommand,
  ) => Effect.Effect<void, ControllerError>
  readonly workspace: (access: ProtocolAccess) => Effect.Effect<ExecutorAssignment, ControllerError>
  readonly ready: (
    access: ProtocolAccess,
    proof: WorkspaceProof,
    capabilities: WorkspaceCapabilitySnapshot,
    environmentDigest: string,
  ) => Effect.Effect<void, ControllerError>
  readonly loadSetupCache: (
    access: ProtocolAccess,
    key: SetupCacheKey,
    environmentDigest: string,
  ) => Effect.Effect<ReturnType<typeof encodeArchive> | null, ControllerError>
  readonly storeSetupCache: (
    access: ProtocolAccess,
    key: SetupCacheKey,
    archive: EncodedArchive,
    environmentDigest: string,
  ) => Effect.Effect<void, ControllerError>
  readonly activatePhase: (access: ProtocolAccess, egress: PhaseEgressPolicy) => Effect.Effect<void, ControllerError>
  readonly cleanupOrphans: Effect.Effect<ReadonlyArray<string>, ControllerError>
}
