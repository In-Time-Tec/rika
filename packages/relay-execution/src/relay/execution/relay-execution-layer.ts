import { Crypto, Layer, PlatformError } from "effect"
import { Runtime } from "@relayfx/sdk"
import { Tool } from "effect/unstable/ai"
import { BackendError, Service as ExecutionService } from "@rika/product/execution-service"
import type { Service as ExecutionServiceType } from "@rika/product/execution-service"
import type { ToolRuntimeRequirements, ExternalToolRuntimeRequirements, LayerOptions } from "./relay-execution-adapter"
import { makeRelayLayer } from "./relay-execution-composition"

type Service = ExecutionServiceType

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
