import { Runtime } from "@relayfx/sdk"
import { Deferred, Layer } from "effect"
import type { Tool } from "effect/unstable/ai"
import * as DataBlobStore from "../../data-blob-store"
import { makeFanOutHost, childResult } from "./relay-fan-out-host"
import { makeWorkflowHost } from "./relay-workflow-host"
import type { ToolRuntimeRequirements, LayerOptions } from "./relay-execution-layer"
import type { Toolkit } from "effect/unstable/ai"
import { fanOutAgentId } from "./relay-execution-input"
import { toolExecutionPolicy } from "./relay-tool-runtime"
import { parentPermissions } from "../../agent/definition/agent-permissions"

export const makeHostRuntime = <
  AdditionalTools extends Record<string, Tool.Any>,
  RuntimeRequirements extends ToolRuntimeRequirements,
  RunnerTools extends Record<string, Tool.Any>,
  ToolError,
  ToolRequirements,
  DatabaseDialect extends Runtime.Dialect,
  DatabaseError,
  DatabaseRequirements,
>(input: {
  readonly options: LayerOptions<AdditionalTools, RuntimeRequirements>
  readonly relayClient: Deferred.Deferred<import("@relayfx/sdk").Client.Interface>
  readonly addressId: import("@relayfx/sdk").Ids.AddressId
  readonly toolkit: Toolkit.Toolkit<RunnerTools>
  readonly languageModelLayer: Layer.Layer<import("@relayfx/sdk").LanguageModelService.Service, never, never>
  readonly toolRuntimeLayer: Layer.Layer<import("@relayfx/sdk").ToolRuntime.HostService, ToolError, ToolRequirements>
  readonly promptAssemblerLayer: Layer.Layer<import("@relayfx/sdk").PromptAssembler.Service>
  readonly database: Runtime.Database<DatabaseDialect, DatabaseError, DatabaseRequirements>
}): Layer.Layer<Runtime.EmbeddedOutput, Runtime.AcquisitionError, ToolRequirements | DatabaseRequirements> => {
  const {
    options,
    relayClient,
    addressId,
    toolkit,
    languageModelLayer,
    toolRuntimeLayer,
    promptAssemblerLayer,
    database,
  } = input
  const fanOutHandlers = makeFanOutHost({
    relayClient,
    toolkit,
    options,
    fanOutAgentId,
    addressId,
    parentPermissions,
    toolExecutionPolicy,
  })
  const workflowHandlers = makeWorkflowHost({ options, relayClient, addressId, toolExecutionPolicy, childResult })
  return Runtime.layerEmbedded({
    database,
    languageModelLayer,
    toolRuntimeLayer,
    blobStoreLayer: DataBlobStore.layer,
    promptAssemblerLayer,
    childFanOutHostLayer: fanOutHandlers,
    workflowDefinitionHostLayer: workflowHandlers,
  })
}
