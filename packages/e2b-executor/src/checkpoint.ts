import { Context, Effect, Schema } from "effect"

export interface Inspection {
  readonly contentDigest: string
  readonly sizeBytes: number
}

export class InspectionError extends Schema.TaggedError<InspectionError>()("InspectionError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly inspect: (objectKey: string) => Effect.Effect<Inspection, InspectionError>
}

export class Inspector extends Context.Service<Inspector, Interface>()("@rika/e2b-executor/checkpoint/Inspector") {}
