import { Duration, Effect, Layer } from "effect"
import { Tool } from "effect/unstable/ai"
import { ModelRegistry, ModelResilience } from "@batonfx/core"
import type { Compaction } from "@batonfx/core"
import { Redacted } from "effect"
import * as RikaToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import { MediaAnalyzer } from "@rika/coding-tools/media-view-service"
import * as ProcessRegistry from "@rika/coding-tools/shell-process-registry"
import * as ReadWebPage from "@rika/coding-tools/read-web-page-service"
import * as WebSearch from "@rika/coding-tools/web-search-service"
import { BackendError } from "@rika/product/execution-service"

export type ModelVariantPolicy = "registration-key" | "fixed-selection"
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
