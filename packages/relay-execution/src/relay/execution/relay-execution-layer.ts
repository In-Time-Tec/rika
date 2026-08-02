import { Crypto, Duration, Effect, Layer, PlatformError, Redacted, Schedule } from "effect"
import { Runtime } from "@relayfx/sdk"
import { ModelRegistry, ModelResilience, Compaction } from "@batonfx/core"
import { Tool } from "effect/unstable/ai"
import { BackendError, Service as ExecutionService } from "@rika/product/execution-service"
import type { Service as ExecutionServiceType } from "@rika/product/execution-service"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { MediaAnalyzer } from "@rika/coding-tools/media-view-service"
import * as ProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import { makeRelayLayer } from "./relay-execution-composition"
import * as Identifier from "./relay-execution-identifier"
import Route from "./relay-execution-route"
import Configured from "./relay-execution-configured"

type ServiceContract = ExecutionServiceType
export { ExecutionService as Service }
type ModelVariantPolicy = "registration-key" | "fixed-selection"
export type ToolRuntimeRequirements =
  ReturnType<typeof RikaToolRuntime.layer> extends Layer.Layer<infer _A, infer _E, infer R> ? R : never
type SuppliedToolRuntimeRequirements =
  | MediaAnalyzer
  | ModelRegistry.ModelRegistry
  | ProcessRegistry.Service
  | ReadWebPage.Service
  | WebSearch.Service
export type ExternalToolRuntimeRequirements<R> = Exclude<ToolRuntimeRequirements | R, SuppliedToolRuntimeRequirements>

export interface LayerOptions<AdditionalTools extends Record<string, Tool.Any> = {}, RuntimeRequirements = never> {
  readonly filename: string
  readonly workspace: string
  readonly webSearchCredentials?: Readonly<Record<string, Redacted.Redacted<string>>>
  readonly registration: ModelRegistry.Registration
  readonly additionalRegistrations?: ReadonlyArray<ModelRegistry.Registration>
  readonly selection: ModelRegistry.ModelSelection
  readonly oracleSelection?: ModelRegistry.ModelSelection
  readonly compactionSummarySelection?: ModelRegistry.ModelSelection
  readonly defaultReasoningEffort?: string
  readonly modelVariantPolicy?: ModelVariantPolicy
  readonly modelResilience?: ModelResilience.Interface
  readonly compaction?: Compaction.DefaultOptions
  readonly oracleCompaction?: Compaction.DefaultOptions
  readonly additionalToolkit?: import("effect/unstable/ai").Toolkit.Toolkit<AdditionalTools>
  readonly additionalHandlerLayer?: Layer.Layer<
    Tool.HandlersFor<AdditionalTools>,
    BackendError,
    Tool.HandlerServices<AdditionalTools[keyof AdditionalTools]>
  >
  readonly toolRuntimeLayer?: Layer.Layer<RikaToolRuntime.Service, BackendError, RuntimeRequirements>
  readonly toolRuntimeLayerForWorkspace?: (
    workspace: string,
  ) => Layer.Layer<RikaToolRuntime.Service, BackendError, RuntimeRequirements | ProcessRegistry.Service>
  readonly resolveWorkspace?: (executionId: string) => Effect.Effect<string, BackendError>
  readonly recoveryChildSettlementGrace?: Duration.Input
}
export const defaultModelResilience: ModelResilience.Interface = {
  ...ModelResilience.none,
  classify: ModelResilience.defaultClassify,
  resolve: ModelResilience.defaultResolveFailure,
  retrySchedule: Schedule.exponential("500 millis", 2).pipe(Schedule.jittered, Schedule.upTo({ times: 3 })),
  invalidToolCallCorrectionLimit: 2,
}
export const route: {
  readonly modelRoutesForExecution: typeof Route.modelRoutesForExecution
  readonly defaultModelRoutes: typeof Route.defaultModelRoutes
  readonly executionRoutePin: typeof Route.executionRoutePin
  readonly resolveExecutionRouteForSettings: typeof Route.resolveExecutionRouteForSettings
  readonly productionCompaction: typeof Route.productionCompaction
} = {
  modelRoutesForExecution: Route.modelRoutesForExecution,
  defaultModelRoutes: Route.defaultModelRoutes,
  executionRoutePin: Route.executionRoutePin,
  resolveExecutionRouteForSettings: Route.resolveExecutionRouteForSettings,
  productionCompaction: Route.productionCompaction,
}
export const execution: {
  readonly turnIdFromExecutionId: typeof Identifier.turnIdFromExecutionId
  readonly workspaceFromExecutionId: typeof Identifier.workspaceFromExecutionId
  readonly configuredLayer: typeof Configured.makeConfiguredLayer
  readonly routeForSettings: typeof Configured.makeConfiguredRoute
  readonly modelRoutes: typeof Configured.configuredExecutionModelRoutes
} = {
  turnIdFromExecutionId: Identifier.turnIdFromExecutionId,
  workspaceFromExecutionId: Identifier.workspaceFromExecutionId,
  configuredLayer: Configured.makeConfiguredLayer,
  routeForSettings: Configured.makeConfiguredRoute,
  modelRoutes: Configured.configuredExecutionModelRoutes,
}

export const layer = <
  AdditionalTools extends Record<string, Tool.Any> = {},
  RuntimeRequirements extends ToolRuntimeRequirements = never,
>(
  options: LayerOptions<AdditionalTools, RuntimeRequirements>,
): Layer.Layer<
  ServiceContract,
  BackendError | PlatformError.PlatformError | Runtime.AcquisitionError,
  Crypto.Crypto | ExternalToolRuntimeRequirements<RuntimeRequirements>
> =>
  makeRelayLayer({
    ...options,
    modelResilience: options.modelResilience ?? defaultModelResilience,
  })

void ExecutionService
