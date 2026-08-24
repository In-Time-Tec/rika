import { Context, Effect, Layer } from "effect"
import { Input } from "./product"
import { OperationUnavailable } from "./product"
import * as ThreadToolHandlers from "../../thread/tool/action"

export interface Interface {
  readonly run: (input: Input) => Effect.Effect<void, OperationUnavailable>
  readonly closeAdmissions?: Effect.Effect<void>
  readonly stopActiveExecutionWork?: Effect.Effect<void, OperationUnavailable>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/operation/contract/product-service/Service",
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

export { productLayer, runAuth } from "../dispatch/product"
export type { AuthOperationOptions } from "../dispatch/authentication"
export { ThreadToolHandlers }
