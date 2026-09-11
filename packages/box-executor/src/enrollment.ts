import { HandshakeEvidence, WorkspaceBinding } from "@rika/execution"
import { Context, Effect, Layer, Schema } from "effect"

import type { BoxId } from "./contract"

export class WorkspaceEnrollmentError extends Schema.TaggedError<WorkspaceEnrollmentError>()(
  "RikaBoxV2WorkspaceEnrollmentError",
  {
    phase: Schema.Literals(["enroll", "handshake"]),
    message: Schema.String,
  },
) {}

export interface WorkspaceEnrollmentService {
  readonly enroll: (boxId: BoxId, binding: WorkspaceBinding) => Effect.Effect<void, WorkspaceEnrollmentError>
  readonly handshake: (
    boxId: BoxId,
    binding: WorkspaceBinding,
  ) => Effect.Effect<HandshakeEvidence, WorkspaceEnrollmentError>
}

export class WorkspaceEnrollment extends Context.Service<WorkspaceEnrollment, WorkspaceEnrollmentService>()(
  "@rika/box-executor/enrollment/WorkspaceEnrollment",
) {}

export const workspaceEnrollmentLayer = (service: WorkspaceEnrollmentService): Layer.Layer<WorkspaceEnrollment> =>
  Layer.succeed(WorkspaceEnrollment, WorkspaceEnrollment.of(service))

export class WorkspaceCheckpointError extends Schema.TaggedError<WorkspaceCheckpointError>()(
  "RikaBoxV2WorkspaceCheckpointError",
  {
    phase: Schema.Literals(["quiesce", "flush"]),
    message: Schema.String,
  },
) {}

export interface WorkspaceCheckpointService {
  readonly quiesce: (binding: WorkspaceBinding) => Effect.Effect<void, WorkspaceCheckpointError>
  readonly flush: (binding: WorkspaceBinding) => Effect.Effect<void, WorkspaceCheckpointError>
}

export class WorkspaceCheckpoint extends Context.Service<WorkspaceCheckpoint, WorkspaceCheckpointService>()(
  "@rika/box-executor/enrollment/WorkspaceCheckpoint",
) {}

export const workspaceCheckpointLayer = (service: WorkspaceCheckpointService): Layer.Layer<WorkspaceCheckpoint> =>
  Layer.succeed(WorkspaceCheckpoint, WorkspaceCheckpoint.of(service))
