import { Context, Effect, Layer, Runtime, Schema } from "effect"
import { Input } from "./product-operation"

export { Input }
export type { Input as OperationInput } from "./product-operation"
export { productLayer, testLayer, runAuth, reconcile } from "../dispatch/product-operation-dispatch"
export * as Operation from "../dispatch/product-operation-dispatch"
export type { ProductLayerOptions } from "../dispatch/product-operation-dispatch"
export type { AuthOperationOptions } from "../dispatch/authentication-operation-dispatch"
export type { InteractiveSession } from "../interactive/interactive-session"
export * as OpenAiAuth from "../../authentication/openai-auth-service"
export * as ExecutionIngest from "../../execution/ingest/execution-ingest-service"
export { ProductAgent } from "../../agent/product-agent-service"
export * as ConfigOperations from "../dispatch/configuration-operation-dispatch"
export * as ExtensionOperations from "../dispatch/extension-operation-dispatch"
export * as ContextFileSystem from "../../context/context-file-system"
export * as ResidentService from "../../resident/resident-service"
export * as ThreadQuery from "../../thread/query/thread-query-service"
export * as ThreadToolService from "../../thread/tool/thread-tool-service"
export * as ThreadToolHandlers from "../../thread/tool/thread-tool-action"
export * as ResolvedContext from "../../context/context-resolution-service"
export { executeInteractiveCommand, InteractiveCommand } from "../interactive/interactive-command"
export { InteractiveEventSchema } from "../interactive/interactive-event"
export type { InteractiveEvent } from "../interactive/interactive-event"

export class OperationUnavailable extends Schema.TaggedErrorClass<OperationUnavailable>()("OperationUnavailable", {
  operation: Schema.String,
  message: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2
  override readonly [Runtime.errorReported] = false
}

export class InvalidInput extends Schema.TaggedErrorClass<InvalidInput>()("InvalidInput", {
  message: Schema.String,
}) {
  override readonly [Runtime.errorExitCode] = 2
  override readonly [Runtime.errorReported] = false
}

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
