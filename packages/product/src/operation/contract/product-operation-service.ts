import { Context, Effect, Layer } from "effect"
import { Input } from "./product-operation"
import { OperationUnavailable } from "./product-operation-errors"
import * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
import * as ConfigOperations from "../dispatch/configuration-operation-dispatch"
import * as ResolvedContext from "../../context/context-resolution-service"
import * as ThreadToolHandlers from "../../thread/tool/thread-tool-action"

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

export {
  productLayer,
  reconcile,
  runAuth,
  hasActiveExecutionWork,
  stopActiveExecutionWork,
  settleAbandonedRecoveredWork,
} from "../dispatch/product-operation-dispatch"
export { Input } from "./product-operation"
export { InvalidInput, OperationUnavailable } from "./product-operation-errors"
export type { InteractiveEvent } from "../interactive/interactive-event"
export { InteractiveEventSchema } from "../interactive/interactive-event"
export type { InteractiveSession } from "../interactive/interactive-session"
export type { ProductLayerOptions } from "../dispatch/product-operation-options"
export { rootExecutionEvents } from "../../execution/lifecycle/root-execution-event"
export { executeInteractiveCommand } from "../interactive/interactive-command"
export { testLayer } from "../dispatch/product-operation-test-layer"
export type { AuthOperationOptions } from "../dispatch/authentication-operation-dispatch"
export { ExecutionIngest, ConfigOperations, ResolvedContext, ThreadToolHandlers }
