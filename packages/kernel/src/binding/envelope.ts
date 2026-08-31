import { NestedOperation, ToolContext } from "generalist"
import type { HostBindings } from "generalist/repl"
import { Effect, Function, Schema } from "effect"

export type Requirements = NestedOperation.Operations | ToolContext.ToolContext

export const NestedOperationFailed = Schema.Struct({
  _tag: Schema.tag("NestedOperationFailed"),
  reason: Schema.Literals(["divergence", "unknown", "denied", "suspended"]),
  kind: Schema.String,
  message: Schema.String,
  token: Schema.optionalKey(Schema.String),
})
export type NestedOperationFailed = typeof NestedOperationFailed.Type

const NestedOperationFailure = Schema.Union([
  NestedOperation.Divergence,
  NestedOperation.Unknown,
  NestedOperation.Denied,
  NestedOperation.Suspended,
])

const failed = (kind: string, failure: NestedOperation.Failure): NestedOperationFailed => {
  if (failure._tag === "generalist/core/NestedOperationDivergence")
    return NestedOperationFailed.make({
      _tag: "NestedOperationFailed",
      reason: "divergence",
      kind,
      message: `nested operation ${failure.ordinal} recorded ${failure.recordedKind} and was requested as ${failure.requestedKind}`,
    })
  if (failure._tag === "generalist/core/NestedOperationUnknown")
    return NestedOperationFailed.make({
      _tag: "NestedOperationFailed",
      reason: "unknown",
      kind,
      message: `nested operation ${failure.operationId} crossed its boundary with an unobserved outcome`,
    })
  if (failure._tag === "generalist/core/NestedOperationDenied")
    return NestedOperationFailed.make({
      _tag: "NestedOperationFailed",
      reason: "denied",
      kind,
      message: `${failure.capability} was denied: ${failure.reason}`,
    })
  return NestedOperationFailed.make({
    _tag: "NestedOperationFailed",
    reason: "suspended",
    kind,
    message: `${failure.capability} awaits approval under token ${failure.token}`,
    token: failure.token,
  })
}

export interface Crossing {
  readonly kind: string
  readonly payload: unknown
  readonly replayPolicy: NestedOperation.ReplayPolicy
  readonly approval?: NestedOperation.ApprovalRequirement
}

export const nested: {
  <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): (request: Crossing) => Effect.Effect<A, E | NestedOperationFailed, R | Requirements>
  <A, E, R>(
    request: Crossing,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | NestedOperationFailed, R | Requirements>
} = Function.dual(
  2,
  <A, E, R>(
    request: Crossing,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | NestedOperationFailed, R | Requirements> =>
    NestedOperation.run(request, effect).pipe(
      Effect.catchIf(Schema.is(NestedOperationFailure), (failure) => Effect.fail(failed(request.kind, failure))),
    ),
)

export const operation = <
  Input extends Schema.Codec<unknown, unknown, never, never>,
  Output extends Schema.Codec<unknown, unknown, never, never>,
  Failure extends Schema.Codec<unknown, unknown, never, never>,
  R,
>(definition: {
  readonly name: string
  readonly input: Input
  readonly output: Output
  readonly failure: Failure
  readonly handle: (input: Input["Type"]) => Effect.Effect<Output["Type"], Failure["Type"] & HostBindings.Tagged, R>
}): HostBindings.AnyOperation<R> => ({
  name: definition.name,
  input: definition.input,
  output: definition.output,
  failure: definition.failure,
  handle: (input) =>
    Schema.is(definition.input)(input)
      ? definition.handle(input)
      : Effect.die(new Error(`Host binding ${definition.name} received invalid decoded input`)),
})
