import {
  PermissionPolicy,
  SkillRegistry,
  SkillToolProvider,
  SubagentRuntime,
  ThreadMemory,
  ToolAccess,
  ToolExecutor,
  ToolRegistry,
} from "@rika/agent"
import { Config, Diagnostics } from "@rika/core"
import { McpApprovalStore } from "@rika/persistence"
import { PluginHost } from "@rika/plugin"
import { Effect, Layer } from "effect"
import { join } from "node:path"
import * as AstGrepOutline from "./ast-grep-outline"
import * as FffSearch from "./fff-search"
import * as HashlineFile from "./hashline-file"
import * as McpClient from "./mcp-client"
import * as SemanticSearch from "./semantic-search"
import * as SpecialtyTools from "./specialty-tools"

export const skillMcpSources = (skills: ReadonlyArray<SkillRegistry.Skill>): ReadonlyArray<McpClient.SettingsSource> =>
  skills.flatMap((skill) =>
    skill.mcp_servers === undefined
      ? []
      : [
          {
            source: "workspace",
            path: join(skill.summary.directory, "mcp.json"),
            default_cwd: skill.summary.directory,
            servers: skill.mcp_servers,
          },
        ],
  )

export const skillToolProviderLayerFromServices: Layer.Layer<SkillToolProvider.Service, never, McpClient.Service> =
  Layer.effect(
    SkillToolProvider.Service,
    Effect.gen(function* () {
      const mcp = yield* McpClient.Service
      return SkillToolProvider.Service.of({
        definitionsForSkills: Effect.fn("BuiltInTools.skillToolProvider.definitionsForSkills")(function* (skills) {
          const sources = skillMcpSources(skills)
          return yield* mcp.toolDefinitionsForSources(sources).pipe(
            Effect.mapError(
              (error) =>
                new SkillToolProvider.SkillToolProviderError({
                  message: error instanceof Error ? error.message : String(error),
                  operation: "definitionsForSkills",
                }),
            ),
          )
        }),
      })
    }),
  )

export const skillToolProviderLayer: Layer.Layer<
  SkillToolProvider.Service,
  McpClient.RunError,
  Config.Service | McpApprovalStore.Service
> = skillToolProviderLayerFromServices.pipe(Layer.provideMerge(McpClient.layer))

interface StandardDefinitionInput {
  readonly workspaceRoot: string
  readonly astGrepOutline: AstGrepOutline.Interface
  readonly fffSearch: FffSearch.Interface
  readonly hashlineFile: HashlineFile.Interface
  readonly mcpDefinitions: ReadonlyArray<ToolRegistry.Definition>
  readonly pluginDefinitions: ReadonlyArray<ToolRegistry.Definition>
  readonly semanticSearch: SemanticSearch.Interface
  readonly specialtyTools: SpecialtyTools.Interface
  readonly threadMemory: ThreadMemory.Interface
  readonly subagentRuntime?: SubagentRuntime.Interface
}

const standardDefinitions = (input: StandardDefinitionInput): ReadonlyArray<ToolRegistry.Definition> => [
  ...ToolRegistry.shellDefinitions(input.workspaceRoot),
  ...(input.subagentRuntime === undefined ? [] : SubagentRuntime.toolDefinitions(input.subagentRuntime)),
  ...SpecialtyTools.toolDefinitions(input.specialtyTools),
  ...input.pluginDefinitions,
  ...input.mcpDefinitions,
  ...ThreadMemory.toolDefinitions(input.threadMemory),
  ...SemanticSearch.toolDefinitions(input.semanticSearch),
  ...FffSearch.toolDefinitions(input.fffSearch),
  ...AstGrepOutline.toolDefinitions(input.astGrepOutline),
  ...HashlineFile.toolDefinitions(input.hashlineFile),
]

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
  | ThreadMemory.Service
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
    const threadMemory = yield* ThreadMemory.Service
    const subagentRuntime = yield* SubagentRuntime.Service
    const pluginDefinitions = yield* PluginHost.toolDefinitions()
    const definitions = standardDefinitions({
      workspaceRoot: values.workspace_root,
      astGrepOutline,
      fffSearch,
      hashlineFile,
      mcpDefinitions,
      pluginDefinitions,
      semanticSearch,
      specialtyTools,
      threadMemory,
      subagentRuntime,
    })

    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(definitions)))
  }),
)

export const fullSubagentRegistryLayerFromServices: Layer.Layer<
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
  | ThreadMemory.Service
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
    const threadMemory = yield* ThreadMemory.Service
    const pluginDefinitions = yield* PluginHost.toolDefinitions()
    const definitions = standardDefinitions({
      workspaceRoot: values.workspace_root,
      astGrepOutline,
      fffSearch,
      hashlineFile,
      mcpDefinitions,
      pluginDefinitions,
      semanticSearch,
      specialtyTools,
      threadMemory,
    }).filter((definition) => definition.tool.name !== "task")

    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(definitions)))
  }),
)

export const readOnlyRegistryLayerFromServices: Layer.Layer<
  ToolRegistry.Service,
  never,
  | AstGrepOutline.Service
  | Config.Service
  | FffSearch.Service
  | HashlineFile.Service
  | SemanticSearch.Service
  | ThreadMemory.Service
> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const astGrepOutline = yield* AstGrepOutline.Service
    const fffSearch = yield* FffSearch.Service
    const hashlineFile = yield* HashlineFile.Service
    const semanticSearch = yield* SemanticSearch.Service
    const threadMemory = yield* ThreadMemory.Service
    const definitions = [
      ...ThreadMemory.toolDefinitions(threadMemory),
      ...SemanticSearch.toolDefinitions(semanticSearch),
      ...FffSearch.toolDefinitions(fffSearch),
      ...AstGrepOutline.toolDefinitions(astGrepOutline),
      ...HashlineFile.toolDefinitions(hashlineFile),
    ].filter((definition) => ToolAccess.isReadOnlyToolName(definition.tool.name))

    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(definitions)))
  }),
)

export const subagentRegistryLayerFromServices: Layer.Layer<
  ToolRegistry.Service,
  never,
  | AstGrepOutline.Service
  | Config.Service
  | FffSearch.Service
  | HashlineFile.Service
  | SemanticSearch.Service
  | ThreadMemory.Service
> = Layer.effect(
  ToolRegistry.Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    const astGrepOutline = yield* AstGrepOutline.Service
    const fffSearch = yield* FffSearch.Service
    const hashlineFile = yield* HashlineFile.Service
    const semanticSearch = yield* SemanticSearch.Service
    const threadMemory = yield* ThreadMemory.Service
    const definitions = [
      ...ToolRegistry.shellDefinitions(values.workspace_root),
      ...ThreadMemory.toolDefinitions(threadMemory),
      ...SemanticSearch.toolDefinitions(semanticSearch),
      ...FffSearch.toolDefinitions(fffSearch),
      ...AstGrepOutline.toolDefinitions(astGrepOutline),
      ...HashlineFile.toolDefinitions(hashlineFile),
    ]

    return yield* ToolRegistry.Service.pipe(Effect.provide(ToolRegistry.layerFromDefinitions(definitions)))
  }),
)

export const registryLayer: Layer.Layer<
  ToolRegistry.Service,
  FffSearch.FffSearchError | McpClient.RunError,
  | Config.Service
  | McpApprovalStore.Service
  | PluginHost.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | ThreadMemory.Service
> = registryLayerFromServices.pipe(
  Layer.provideMerge(SemanticSearch.layer),
  Layer.provideMerge(FffSearch.layer),
  Layer.provideMerge(AstGrepOutline.layer),
  Layer.provideMerge(HashlineFile.layer),
  Layer.provideMerge(McpClient.layer),
)

export const readOnlyRegistryLayer: Layer.Layer<
  ToolRegistry.Service,
  FffSearch.FffSearchError,
  Config.Service | ThreadMemory.Service
> = readOnlyRegistryLayerFromServices.pipe(
  Layer.provideMerge(SemanticSearch.layer),
  Layer.provideMerge(FffSearch.layer),
  Layer.provideMerge(AstGrepOutline.layer),
  Layer.provideMerge(HashlineFile.layer),
)

export const subagentRegistryLayer: Layer.Layer<
  ToolRegistry.Service,
  FffSearch.FffSearchError,
  Config.Service | ThreadMemory.Service
> = subagentRegistryLayerFromServices.pipe(
  Layer.provideMerge(SemanticSearch.layer),
  Layer.provideMerge(FffSearch.layer),
  Layer.provideMerge(AstGrepOutline.layer),
  Layer.provideMerge(HashlineFile.layer),
)

export const fullSubagentRegistryLayer: Layer.Layer<
  ToolRegistry.Service,
  FffSearch.FffSearchError | McpClient.RunError,
  Config.Service | McpApprovalStore.Service | PluginHost.Service | SpecialtyTools.Service | ThreadMemory.Service
> = fullSubagentRegistryLayerFromServices.pipe(
  Layer.provideMerge(SemanticSearch.layer),
  Layer.provideMerge(FffSearch.layer),
  Layer.provideMerge(AstGrepOutline.layer),
  Layer.provideMerge(HashlineFile.layer),
  Layer.provideMerge(McpClient.layer),
)

export const configuredSubagentRegistryLayer: Layer.Layer<
  ToolRegistry.Service,
  FffSearch.FffSearchError | McpClient.RunError,
  Config.Service | McpApprovalStore.Service | PluginHost.Service | SpecialtyTools.Service | ThreadMemory.Service
> = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* Config.Service
    const values = yield* config.get
    return Config.subagentTools(values) === "full" ? fullSubagentRegistryLayer : readOnlyRegistryLayer
  }),
)

export const toolExecutorLayerFromPermissionConfig = (
  permissionConfig: PermissionPolicy.PermissionConfig = PermissionPolicy.defaultConfig,
): Layer.Layer<
  ToolExecutor.Service,
  FffSearch.FffSearchError | McpClient.RunError,
  | Config.Service
  | McpApprovalStore.Service
  | PluginHost.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | Diagnostics.Service
  | ThreadMemory.Service
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
): Layer.Layer<
  ToolExecutor.ReadOnlyService,
  FffSearch.FffSearchError,
  Config.Service | Diagnostics.Service | ThreadMemory.Service
> =>
  ToolExecutor.readOnlyLayer.pipe(
    Layer.provideMerge(readOnlyRegistryLayer),
    Layer.provideMerge(PermissionPolicy.layerFromConfig(permissionConfig)),
  )

export const readOnlyToolExecutorLayer = readOnlyToolExecutorLayerFromPermissionConfig()

export const subagentToolExecutorLayerFromPermissionConfig = (
  permissionConfig: PermissionPolicy.PermissionConfig = PermissionPolicy.defaultConfig,
): Layer.Layer<
  ToolExecutor.SubagentService,
  FffSearch.FffSearchError | McpClient.RunError,
  | Config.Service
  | Diagnostics.Service
  | McpApprovalStore.Service
  | PluginHost.Service
  | SpecialtyTools.Service
  | ThreadMemory.Service
> =>
  ToolExecutor.subagentLayer.pipe(
    Layer.provideMerge(configuredSubagentRegistryLayer),
    Layer.provideMerge(PermissionPolicy.layerFromConfig(permissionConfig)),
  )

export const subagentToolExecutorLayer = subagentToolExecutorLayerFromPermissionConfig()
