import { Crypto, Layer, PlatformError } from "effect"
import { Runtime } from "@relayfx/sdk"
import { Tool } from "effect/unstable/ai"
import * as ExecutionServiceContract from "@rika/product/execution-service"
import { BackendError, Service as ExecutionService } from "@rika/product/execution-service"
export { BackendError }
import type { ToolRuntimeRequirements, ExternalToolRuntimeRequirements, LayerOptions } from "./relay-execution-adapter"
import { makeRelayLayer } from "./relay-execution-composition"
import * as Identifier from "./relay-execution-identifier"
import { webSearchFactories } from "../../model/routing/relay-model-tools"
import { defaultModelResilience } from "../../model/routing/relay-model-registry"
import type { ModelVariantPolicy } from "./relay-execution-adapter"
import { Compaction, ModelRegistry } from "@batonfx/core"

export { ExecutionService as Service }
export type Interface = ExecutionServiceContract.Interface
export type { LayerOptions, ModelVariantPolicy }
export { webSearchFactories, defaultModelResilience }
export const turnIdFromExecutionId = Identifier.turnIdFromExecutionId
export const workspaceFromExecutionId = Identifier.workspaceFromExecutionId
export type ModelRegistration = ModelRegistry.Registration
export type ModelSelection = ModelRegistry.ModelSelection
export type CompactionOptions = Compaction.DefaultOptions

export const layer = <
  AdditionalTools extends Record<string, Tool.Any> = {},
  RuntimeRequirements extends ToolRuntimeRequirements = never,
>(
  options: LayerOptions<AdditionalTools, RuntimeRequirements>,
): Layer.Layer<
  ExecutionServiceContract.Interface,
  BackendError | PlatformError.PlatformError | Runtime.AcquisitionError,
  Crypto.Crypto | ExternalToolRuntimeRequirements<RuntimeRequirements>
> => makeRelayLayer(options)

void ExecutionService
