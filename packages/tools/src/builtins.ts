import { PermissionPolicy, SubagentRuntime, ToolExecutor, ToolRegistry } from "@rika/agent"
import { Config } from "@rika/core"
import { McpApprovalStore } from "@rika/persistence"
import { PluginHost } from "@rika/plugin"
import { Effect, Layer } from "effect"
import * as AstGrepOutline from "./ast-grep-outline"
import * as FffSearch from "./fff-search"
import * as HashlineFile from "./hashline-file"
import * as McpClient from "./mcp-client"
import * as SemanticSearch from "./semantic-search"
import * as SpecialtyTools from "./specialty-tools"

export const registryLayerFromServices: Layer.Layer<
  ToolRegistry.Service,
  McpClient.RunError,
  | AstGrepOutline.Service
  | Config.Service
  | FffSearch.Service
  | HashlineFile.Service
  | McpClient.Service
  | PluginHost.Service
  | SemanticSearch.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    const astGrepOutline = yield* AstGrepOutline.Service
    const fffSearch = yield* FffSearch.Service
    const hashlineFile = yield* HashlineFile.Service
    const mcpDefinitions = yield* McpClient.toolDefinitions()
    const semanticSearch = yield* SemanticSearch.Service
    const specialtyTools = yield* SpecialtyTools.Service
    const subagentRuntime = yield* SubagentRuntime.Service
    const pluginDefinitions = yield* PluginHost.toolDefinitions()
    const definitions = [
      ...ToolRegistry.shellDefinitions(values.workspace_root),
      ...SubagentRuntime.toolDefinitions(subagentRuntime),
      ...SpecialtyTools.toolDefinitions(specialtyTools),
      ...pluginDefinitions,
      ...mcpDefinitions,
      ...SemanticSearch.toolDefinitions(semanticSearch),
      ...FffSearch.toolDefinitions(fffSearch),
      ...AstGrepOutline.toolDefinitions(astGrepOutline),
      ...HashlineFile.toolDefinitions(hashlineFile),
    ]

    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(definitions)))
  }),
)

export const readOnlyRegistryLayerFromServices: Layer.Layer<
  ToolRegistry.Service,
  never,
  AstGrepOutline.Service | Config.Service | FffSearch.Service | HashlineFile.Service | SemanticSearch.Service
> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const astGrepOutline = yield* AstGrepOutline.Service
    const fffSearch = yield* FffSearch.Service
    const hashlineFile = yield* HashlineFile.Service
    const semanticSearch = yield* SemanticSearch.Service
    const definitions = [
      ...SemanticSearch.toolDefinitions(semanticSearch),
      ...FffSearch.toolDefinitions(fffSearch),
      ...AstGrepOutline.toolDefinitions(astGrepOutline),
      ...HashlineFile.toolDefinitions(hashlineFile),
    ].filter((definition) => SubagentRuntime.readOnlyToolNames.some((name) => name === definition.tool.name))

    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(definitions)))
  }),
)

export const registryLayer: Layer.Layer<
  ToolRegistry.Service,
  FffSearch.FffSearchError | McpClient.RunError,
  Config.Service | McpApprovalStore.Service | PluginHost.Service | SpecialtyTools.Service | SubagentRuntime.Service
> = registryLayerFromServices.pipe(
  Layer.provideMerge(SemanticSearch.layer),
  Layer.provideMerge(FffSearch.layer),
  Layer.provideMerge(AstGrepOutline.layer),
  Layer.provideMerge(HashlineFile.layer),
  Layer.provideMerge(McpClient.layer),
)

export const readOnlyRegistryLayer: Layer.Layer<ToolRegistry.Service, FffSearch.FffSearchError, Config.Service> =
  readOnlyRegistryLayerFromServices.pipe(
    Layer.provideMerge(SemanticSearch.layer),
    Layer.provideMerge(FffSearch.layer),
    Layer.provideMerge(AstGrepOutline.layer),
    Layer.provideMerge(HashlineFile.layer),
  )

export const toolExecutorLayerFromPermissionConfig = (
  permissionConfig: PermissionPolicy.PermissionConfig = PermissionPolicy.defaultConfig,
): Layer.Layer<
  ToolExecutor.Service,
  FffSearch.FffSearchError | McpClient.RunError,
  Config.Service | McpApprovalStore.Service | PluginHost.Service | SpecialtyTools.Service | SubagentRuntime.Service
> =>
  PluginHost.toolResultExecutorLayer.pipe(
    Layer.provideMerge(
      ToolExecutor.layer.pipe(
        Layer.provideMerge(registryLayer),
        Layer.provideMerge(PluginHost.permissionPolicyLayerFromConfig(permissionConfig)),
      ),
    ),
  )

export const toolExecutorLayer = toolExecutorLayerFromPermissionConfig()

export const readOnlyToolExecutorLayerFromPermissionConfig = (
  permissionConfig: PermissionPolicy.PermissionConfig = PermissionPolicy.defaultConfig,
): Layer.Layer<ToolExecutor.ReadOnlyService, FffSearch.FffSearchError, Config.Service> =>
  ToolExecutor.readOnlyLayer.pipe(
    Layer.provideMerge(readOnlyRegistryLayer),
    Layer.provideMerge(PermissionPolicy.layerFromConfig(permissionConfig)),
  )

export const readOnlyToolExecutorLayer = readOnlyToolExecutorLayerFromPermissionConfig()
