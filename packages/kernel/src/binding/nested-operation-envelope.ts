import { NestedOperation, ToolContext } from "tenetkit"
import type { HostBindingRegistry } from "tenetkit/repl"
import { Effect, Function, Schema } from "effect"

export type Requirements = NestedOperation.NestedOperations | ToolContext.ToolContext

export const NestedOperationFailed = Schema.Struct({
  _tag: Schema.tag("NestedOperationFailed"),
  reason: Schema.Literals(["divergence", "unknown", "denied", "suspended"]),
  kind: Schema.String,
  message: Schema.String,
})
export type NestedOperationFailed = typeof NestedOperationFailed.Type

const failed = (kind: string, failure: NestedOperation.Failure): NestedOperationFailed => {
  if (failure._tag === "tenetkit/core/NestedOperationDivergence")
    return NestedOperationFailed.make({
      _tag: "NestedOperationFailed",
      reason: "divergence",
      kind,
      message: `nested operation ${failure.ordinal} recorded ${failure.recordedKind} and was requested as ${failure.requestedKind}`,
    })
  if (failure._tag === "tenetkit/core/NestedOperationUnknown")
    return NestedOperationFailed.make({
      _tag: "NestedOperationFailed",
      reason: "unknown",
      kind,
      message: `nested operation ${failure.operationId} crossed its boundary with an unobserved outcome`,
    })
  if (failure._tag === "tenetkit/core/NestedOperationDenied")
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
  })
}

export interface Crossing {
  readonly kind: string
  readonly payload: unknown
  readonly replayPolicy: NestedOperation.NestedReplayPolicy
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
    NestedOperation.run(
      {
        kind: request.kind,
        payload: request.payload,
        replayPolicy: request.replayPolicy,
        ...(request.approval === undefined ? {} : { approval: request.approval }),
      },
      effect,
    ).pipe(
      Effect.mapError((error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        String(error._tag).startsWith("tenetkit/core/")
          ? failed(request.kind, error as NestedOperation.Failure)
          : (error as E),
      ),
    ),
)

export const operation = <
  Input extends Schema.Constraint,
  Output extends Schema.Constraint,
  Failure extends Schema.Constraint,
  R,
>(definition: {
  readonly name: string
  readonly input: Input
  readonly output: Output
  readonly failure: Failure
  readonly handle: (
    input: Input["Type"],
  ) => Effect.Effect<Output["Type"], Failure["Type"] & HostBindingRegistry.Tagged, R>
}): HostBindingRegistry.AnyOperation<R> => definition as unknown as HostBindingRegistry.AnyOperation<R>
