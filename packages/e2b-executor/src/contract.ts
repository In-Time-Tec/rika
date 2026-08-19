import type { ExecutorCursor, FilesystemCheckpoint } from "@rika/remote-execution/protocol"
import { Redacted, Schema } from "effect"

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512))
const Generation = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))

export const AssignmentRequest = Schema.Struct({
  assignmentId: Identifier,
  workspaceId: Identifier,
  repository: Schema.Struct({
    owner: Identifier,
    name: Identifier,
    installationId: Identifier,
    ref: Schema.optionalKey(Identifier),
  }),
})
export type AssignmentRequest = typeof AssignmentRequest.Type

export const AssignmentKey = Schema.Struct({
  assignmentId: Identifier,
  generation: Generation,
})
export type AssignmentKey = typeof AssignmentKey.Type

export interface Assignment {
  readonly assignmentId: string
  readonly workspaceId: string
  readonly generation: number
  readonly templateBuildId: string
  readonly sandboxId?: string
  readonly state: "provisioning" | "replacing" | "running" | "paused" | "terminated"
  readonly cursor: ExecutorCursor
}

export interface VerifiedCheckpoint {
  readonly assignmentId: string
  readonly generation: number
  readonly sandboxId: string
  readonly checkpoint: FilesystemCheckpoint
  readonly verifiedAt: number
}

export interface CheckoutCredential {
  readonly repositoryUrl: string
  readonly username: "x-access-token"
  readonly token: Redacted.Redacted<string>
  readonly expiresAt: number
}

export interface ExecutorWelcome {
  readonly version: 1
  readonly fence: import("@rika/remote-execution/protocol").ExecutorFence
  readonly sessionToken: Redacted.Redacted<string>
  readonly leaseExpiresAt: number
  readonly heartbeatIntervalMillis: number
  readonly cursor: ExecutorCursor
}

export interface ExecutorReconnectWelcome {
  readonly version: 1
  readonly fence: import("@rika/remote-execution/protocol").ExecutorFence
  readonly leaseExpiresAt: number
  readonly heartbeatIntervalMillis: number
  readonly cursor: ExecutorCursor
}

export interface LeaseReceipt {
  readonly version: 1
  readonly fence: import("@rika/remote-execution/protocol").ExecutorFence
  readonly leaseExpiresAt: number
  readonly cursor: ExecutorCursor
}

export class E2BExecutionError extends Schema.TaggedError<E2BExecutionError>()("E2BExecutionError", {
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
