import { Context, Effect, Schema } from "effect"

export interface CheckpointObjectInspection {
  readonly contentDigest: string
  readonly sizeBytes: number
}

export class CheckpointInspectionError extends Schema.TaggedError<CheckpointInspectionError>()(
  "CheckpointInspectionError",
  { message: Schema.String },
) {}

export interface Interface {
  readonly inspect: (objectKey: string) => Effect.Effect<CheckpointObjectInspection, CheckpointInspectionError>
}

export class CheckpointObjectInspector extends Context.Service<CheckpointObjectInspector, Interface>()(
  "@rika/e2b-executor/checkpoint/CheckpointObjectInspector",
) {}
