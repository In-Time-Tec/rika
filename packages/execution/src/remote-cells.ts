import { Context, Effect, Layer, Schema } from "effect"

const NonEmptyString = Schema.String.check(Schema.isNonEmpty())
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const Request = Schema.Struct({
  operationKey: NonEmptyString,
  workspace: NonEmptyString,
  sessionId: NonEmptyString,
  toolCallId: NonEmptyString,
  code: Schema.String,
  runId: Schema.optionalKey(NonEmptyString),
  rootRunId: Schema.optionalKey(NonEmptyString),
  attempt: Schema.optionalKey(NonNegativeInt),
  admittedAt: Schema.optionalKey(NonEmptyString),
  deadline: Schema.optionalKey(NonEmptyString),
})

export type Request = typeof Request.Type

export const Response = Schema.Union([
  Schema.TaggedStruct("Success", { result: Schema.Unknown }),
  Schema.TaggedStruct("DomainFailure", { failure: Schema.Unknown }),
  Schema.TaggedStruct("Suspend", { token: Schema.String }),
])

export type Response = typeof Response.Type

export class Unavailable extends Schema.TaggedError<Unavailable>()(
  "@rika/execution/remote-cells/Unavailable",
  { message: Schema.String },
) {}

export interface Interface {
  readonly execute: (request: Request) => Effect.Effect<unknown, Unavailable>
}

export class Service extends Context.Service<Service, Interface>()("@rika/execution/remote-cells/Service") {}

export const layer = (service: Interface): Layer.Layer<Service> => Layer.succeed(Service, Service.of(service))
