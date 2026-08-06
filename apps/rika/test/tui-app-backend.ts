import * as BatonExecution from "@rika/baton-execution/baton-execution"
import type { LaneModels } from "@rika/baton-execution/baton-test-harness"
import { Catalog as CodingToolCatalog } from "@rika/coding-tools/coding-tool-catalog"
import * as ToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as JavaScriptSandbox from "@rika/javascript-sandbox/javascript-sandbox"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as ThreadToolAction from "@rika/product/thread-tool-action"
import { Layer } from "effect"

export interface BackendOptions {
  readonly filename: string
  readonly registryLayer: LaneModels["registryLayer"]
  readonly toolRuntimeLayer: Layer.Layer<ToolRuntime.Service>
  readonly queryFactoryLayer: Layer.Layer<ThreadQuery.Factory>
}

export const backendLayer = (options: BackendOptions) =>
  BatonExecution.layer({
    filename: options.filename,
    modelServices: options.registryLayer,
    agentServices: (workspace) =>
      Layer.mergeAll(
        CodingToolCatalog.handlerLayer.pipe(Layer.provide(options.toolRuntimeLayer)),
        ThreadToolAction.handlerLayerForWorkspace(workspace).pipe(Layer.provide(options.queryFactoryLayer)),
        ThreadToolAction.findHandlerLayerForWorkspace(workspace).pipe(Layer.provide(options.queryFactoryLayer)),
      ) as Layer.Layer<BatonExecution.AgentToolServices>,
  }).pipe(Layer.provide(JavaScriptSandbox.layer()))
