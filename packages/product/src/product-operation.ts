import * as Dispatch from "./operation/dispatch/product-operation-dispatch"
import { InteractiveEventSchema as EventSchema } from "./operation/interactive/interactive-event"
import {
  InvalidInput as InvalidInputError,
  Service as OperationService,
  unavailableLayer as unavailableOperationsLayer,
} from "./operation/contract/product-operation-service"
import type { Interface as OperationInterface } from "./operation/contract/product-operation-service"
import type { InteractiveCommand as InteractiveCommandType } from "./operation/interactive/interactive-command"
import type {
  InteractiveEvent as InteractiveEventType,
  QueueChange as QueueChangeType,
  QueueItem as QueueItemType,
} from "./operation/interactive/interactive-event"
import type { InteractiveSession as InteractiveSessionType } from "./operation/interactive/interactive-session"
import * as ExecutionIngest from "./execution/ingest/execution-ingest-service"
import * as ResolvedContextModule from "./context/context-resolution-service"
import * as ThreadQuery from "./thread/query/thread-query-service"
import * as ThreadToolAction from "./thread/tool/thread-tool-action"
import { executeInteractiveCommand } from "./operation/interactive/interactive-command"
import * as ProductAgentContract from "./agent/product-agent-service"
import * as Coordination from "./operation/dispatch/execution-operation-coordination"
import { OperationUnavailable as Unavailable } from "./operation/contract/product-operation-service"
import type { Input as ResolvedInput } from "./context/resolved-context"

export { ExecutionIngest, ThreadQuery }
export namespace ResolvedContext {
  export const Service = ResolvedContextModule.Service
  export const testLayer = ResolvedContextModule.testLayer
  export type Input = ResolvedInput
}
export type { Input } from "./operation/contract/product-operation"
export { executeInteractiveCommand }
export { EventSchema as InteractiveEventSchema }
export namespace Operation {
  export const productLayer = Dispatch.productLayer
  export const Service = OperationService
  export const unavailableLayer = unavailableOperationsLayer
  export const runAuth = Dispatch.runAuth
  export const reconcile = Dispatch.reconcile
  export type ProductLayerOptions<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError = never,
    TranscriptError = never,
    ThreadInteractionError = never,
    UsageError = never,
  > = Dispatch.ProductLayerOptions<
    ThreadError,
    TurnError,
    BackendError,
    ThreadSummaryError,
    TranscriptError,
    ThreadInteractionError,
    UsageError
  >
  export type Input = import("./operation/contract/product-operation").Input
  export type InteractiveSession = InteractiveSessionType
  export type InteractiveEvent = InteractiveEventType
  export type InteractiveCommand = InteractiveCommandType
  export type QueueChange = QueueChangeType
  export type QueueItem = QueueItemType
  export type Interface = OperationInterface
  export type AuthOperationOptions =
    import("./operation/dispatch/authentication-operation-dispatch").AuthOperationOptions
  export const InteractiveEventSchema = EventSchema
  export const InvalidInput = InvalidInputError
  export const OperationUnavailable = Unavailable
  export type OperationUnavailable = Unavailable
  export const testLayer = Dispatch.testLayer
  export const hasActiveExecutionWork = Coordination.hasActiveExecutionWork
  export const stopActiveExecutionWork = Coordination.stopActiveExecutionWork
  export const settleAbandonedRecoveredWork = Coordination.settleAbandonedRecoveredWork
  export const rootExecutionEvents = Coordination.rootExecutionEvents
}
export namespace ProductAgent {
  export const Service = ProductAgentContract.Service
  export type Interface = ProductAgentContract.Interface
}
export const ThreadToolHandlers = {
  publicReadResult: ThreadToolAction.publicReadResult,
  findHandlerLayer: ThreadToolAction.findHandlerLayer,
  findHandlerLayerForWorkspace: ThreadToolAction.findHandlerLayerForWorkspace,
}
