import { Crypto, Layer, PlatformError } from "effect"
import { Runtime } from "@relayfx/sdk"
import { Tool } from "effect/unstable/ai"
import { BackendError, Service as ExecutionService } from "@rika/product/execution-service"
import type { Service as ExecutionServiceType } from "@rika/product/execution-service"
import type { ToolRuntimeRequirements, ExternalToolRuntimeRequirements, LayerOptions } from "./relay-execution-adapter"
import { makeRelayLayer } from "./relay-execution-composition"

type Service = ExecutionServiceType

export { AgentProfile } from "@rika/product/execution-child-run"
export type { AgentProfile as AgentProfileType } from "@rika/product/execution-child-run"
export { BackendError, ExecutionService as Service }
export { Event } from "@rika/product/execution-event"
export { executionReference } from "@rika/product/execution-identifier"
export { Status } from "@rika/product/execution-status"
export type { ExecutionCheckpoint, Result, EventPage } from "@rika/product/execution-event"
export type {
  ExecutionReference,
  InvocationSource,
  OpenRootExecution,
  TurnPromoter,
} from "@rika/product/execution-identifier"
export type { EventScope, PromptPart, SessionPurpose, StartInput } from "@rika/product/execution-request"
export type {
  ChildEvent,
  ChildProjection,
  FanOutInput,
  FanOutInspection,
  InvokeChildInput,
  JoinPolicy,
} from "@rika/product/execution-child-run"
export type { PendingApproval } from "@rika/product/execution-approval"
export type { Inspection } from "@rika/product/execution-inspection"
export type { ExecutionExtensionPin, WorkflowInspection } from "@rika/product/execution-workflow"
export type { Interface } from "@rika/product/execution-service"
export { layerFromClient } from "./relay-execution-client-layer"
export { buildChildRunInput } from "./relay-execution-input"
export type {
  LayerOptions,
  ModelVariantPolicy,
  ToolRuntimeRequirements,
  ExternalToolRuntimeRequirements,
} from "./relay-execution-adapter"
export {
  lazyModelRegistryLayer,
  defaultModelResilience,
  modelVariantKey,
  toolkitFor,
  webSearchFactories,
} from "../../model/routing/relay-model-registry"
export { turnIdFromExecutionId, workspaceFromExecutionId } from "./relay-execution-identifier"
export { eventHistoryOption } from "../../model/routing/relay-model-registry"
export * as ContextCompaction from "../../context-compaction"
export * as StreamingOnlyModel from "../../streaming-only-model"
export * as PromptCache from "../../prompt-cache"
export * as WorkflowDefinitions from "../relay-workflow-compiler"
export type { ExecutionRoutePin } from "@rika/product/execution-route-snapshot"

export const layer = <
  AdditionalTools extends Record<string, Tool.Any> = {},
  RuntimeRequirements extends ToolRuntimeRequirements = never,
>(
  options: LayerOptions<AdditionalTools, RuntimeRequirements>,
): Layer.Layer<
  Service,
  BackendError | PlatformError.PlatformError | Runtime.AcquisitionError,
  Crypto.Crypto | ExternalToolRuntimeRequirements<RuntimeRequirements>
> => makeRelayLayer(options)

void ExecutionService
