import type { ExecutorCursor } from "@rika/remote-execution/protocol"
import { Context, Effect, Schema } from "effect"
import type { AssignmentRequest, VerifiedCheckpoint } from "./contract"

export interface AssignmentRecord {
  readonly assignmentId: string
  readonly workspaceId: string
  readonly repository: AssignmentRequest["repository"]
  readonly generation: number
  readonly templateBuildId: string
  readonly state: "provisioning" | "replacing" | "running" | "paused" | "terminated"
  readonly sandboxId?: string
  readonly executorId?: string
  readonly bootstrapDigest: string
  readonly bootstrapExpiresAt: number
  readonly bootstrapConsumedAt?: number
  readonly sessionDigest?: string
  readonly leaseExpiresAt?: number
  readonly lastActiveAt: number
  readonly cursor: ExecutorCursor
  readonly checkpoints: ReadonlyArray<VerifiedCheckpoint>
  readonly revision: number
}

export class AssignmentStoreError extends Schema.TaggedError<AssignmentStoreError>()("AssignmentStoreError", {
  kind: Schema.Literals(["conflict", "missing", "storage"]),
  message: Schema.String,
}) {}

export interface Interface {
  readonly get: (assignmentId: string) => Effect.Effect<AssignmentRecord | undefined, AssignmentStoreError>
  readonly insert: (record: AssignmentRecord) => Effect.Effect<AssignmentRecord, AssignmentStoreError>
  readonly update: (
    record: AssignmentRecord,
    expectedRevision: number,
  ) => Effect.Effect<AssignmentRecord, AssignmentStoreError>
  readonly list: Effect.Effect<ReadonlyArray<AssignmentRecord>, AssignmentStoreError>
}

export class AssignmentStore extends Context.Service<AssignmentStore, Interface>()(
  "@rika/e2b-executor/assignment-store/AssignmentStore",
) {}
