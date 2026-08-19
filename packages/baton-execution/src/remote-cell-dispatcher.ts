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

export class DispatchUnavailable extends Schema.TaggedError<DispatchUnavailable>()(
  "@rika/baton-execution/RemoteCellDispatchUnavailable",
  { message: Schema.String },
) {}

export interface Interface {
  readonly dispatchDeduplicated: (request: Request) => Effect.Effect<unknown, DispatchUnavailable>
}

export class RemoteCellDispatcher extends Context.Service<RemoteCellDispatcher, Interface>()(
  "@rika/baton-execution/remote-cell-dispatcher/RemoteCellDispatcher",
) {}

export const layer = (service: Interface): Layer.Layer<RemoteCellDispatcher> =>
  Layer.succeed(RemoteCellDispatcher, RemoteCellDispatcher.of(service))
