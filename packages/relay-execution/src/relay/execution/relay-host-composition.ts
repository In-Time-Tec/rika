import { Runtime } from "@relayfx/sdk"
import { Deferred, Layer } from "effect"
import type { Tool } from "effect/unstable/ai"
import * as DataBlobStore from "../../data-blob-store"
import { makeFanOutHost, childResult } from "./host/relay-fan-out-host"
import { makeWorkflowHost } from "./host/relay-workflow-host"
import type { ToolRuntimeRequirements, LayerOptions } from "./relay-execution-layer"
import { fanOutAgentId } from "./relay-execution-input"
import { toolExecutionPolicy } from "./relay-tool-runtime"
import { parentPermissions } from "../../agent/definition/agent-permissions"

export const makeHostRuntime = <
  AdditionalTools extends Record<string, Tool.Any>,
  RuntimeRequirements extends ToolRuntimeRequirements,
>(input: {
  readonly options: LayerOptions<AdditionalTools, RuntimeRequirements>
  readonly relayClient: Deferred.Deferred<import("@relayfx/sdk").Client.Interface>
  readonly addressId: import("@relayfx/sdk").Ids.AddressId
  readonly toolkit: import("effect/unstable/ai").Toolkit.Toolkit<Record<string, Tool.Any>>
  readonly languageModelLayer: Layer.Layer<any, any, any>
  readonly toolRuntimeLayer: Layer.Layer<any, any, any>
  readonly promptAssemblerLayer: Layer.Layer<any, any, any>
  readonly database: Parameters<typeof Runtime.layerEmbedded>[0]["database"]
}) => {
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
