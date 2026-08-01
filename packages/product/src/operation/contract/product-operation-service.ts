import { Context, Effect, Layer } from "effect"
import { Input } from "./product-operation"
import { OperationUnavailable } from "./product-operation-errors"

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<void, OperationUnavailable>
  readonly hasActiveExecutionWork?: Effect.Effect<boolean, OperationUnavailable>
  readonly authorizeResidentReplacement?: Effect.Effect<"defer" | "supersede", OperationUnavailable>
  readonly stopActiveExecutionWork?: Effect.Effect<void, OperationUnavailable>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/operation/contract/product-operation-service/Service",
) {}

export const unavailableLayer = Layer.succeed(
  Service,
  Service.of({
    run: Effect.fn("ProductOperation.run")(function* (input) {
      return yield* OperationUnavailable.make({
        operation: input._tag,
        message: `${input._tag} is specified but not implemented yet`,
      })
    }),
  }),
)
