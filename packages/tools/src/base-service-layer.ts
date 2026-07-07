import {
  AgentLoop,
  ContextResolver,
  PermissionPolicy,
  SkillRegistry,
  SkillToolProvider,
  SubagentRuntime,
  ThreadMemory,
  ThreadMemoryIndexer,
  ThreadService,
  Toolkit,
  ToolExecutor,
  WorkspaceAccess,
} from "@rika/agent"
import { Config, Diagnostics, EnvConfig, IdGenerator, SecretRedactor, Settings, Time } from "@rika/core"
import { Embeddings, Live, Router } from "@rika/llm"
import {
  ArtifactStore,
  Database,
  McpApprovalStore,
  Migration,
  OrbStore,
  ProjectStore,
  ThreadEventLog,
  ThreadMemoryStore,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { PluginHost, PluginUi } from "@rika/plugin"
import { Effect, Layer } from "effect"
import * as BuiltInTools from "./builtins"
import * as FffSearch from "./fff-search"
import * as McpClient from "./mcp-client"
import * as SpecialtyTools from "./specialty-tools"

export type DatabaseMode = "live" | "memory"

export interface Options {
  readonly env: Record<string, string | undefined>
  readonly workspaceRoot: string
  readonly configLayer: Layer.Layer<Config.Service, Config.ConfigError>
  readonly databaseMode?: DatabaseMode
  readonly diagnosticsLayer?: Layer.Layer<Diagnostics.Service, Error>
  readonly redactorLayer?: Layer.Layer<SecretRedactor.Service>
  readonly permissionConfig?: PermissionPolicy.PermissionConfig
}

export interface RuntimeEnvValidationInput {
  readonly env: Record<string, string | undefined>
  readonly workspaceRoot: string
}

export type StorageOutput =
  | ArtifactStore.Service
  | Config.Service
  | Database.Service
  | IdGenerator.Service
  | McpApprovalStore.Service
  | Migration.Service
  | ProjectStore.Service
  | SecretRedactor.Service
  | Settings.Service
  | ThreadEventLog.Service
  | ThreadMemoryStore.Service
  | ThreadProjection.Service
  | Time.Service
  | WorkspaceStore.Service

export type BaseOutput =
  | StorageOutput
  | ContextResolver.Service
  | Diagnostics.Service
  | Embeddings.Service
  | PluginHost.Service
  | Router.Service
  | SkillRegistry.Service
  | SkillToolProvider.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | ThreadMemory.Service
  | ThreadService.Service
  | Toolkit.Service
  | ToolExecutor.Service
  | WorkspaceAccess.Service

export type CommonOutput = BaseOutput | AgentLoop.Service

export type Output = BaseOutput | AgentLoop.Service | OrbStore.Service | ThreadMemoryIndexer.Service

export type Error =
  | Config.ConfigError
  | ContextResolver.ContextResolverError
  | Database.DatabaseError
  | FffSearch.FffSearchError
  | McpApprovalStore.McpApprovalStoreError
  | McpClient.RunError
  | Migration.MigrationError
  | OrbStore.OrbStoreError
  | PluginHost.RunError
  | ProjectStore.ProjectStoreError
  | Settings.SettingsError
  | ThreadEventLog.ThreadEventLogError
  | ThreadMemoryStore.ThreadMemoryStoreError
  | ThreadProjection.ThreadProjectionError

export const validateRuntimeEnv = Effect.fn("BaseServiceLayer.validateRuntimeEnv")(function* (
  input: RuntimeEnvValidationInput,
) {
  const configEnv = {
    ...input.env,
    RIKA_WORKSPACE_ROOT: input.workspaceRoot,
  }
  yield* Config.valuesFromEnv(configEnv, input.workspaceRoot)
  const provider = EnvConfig.providerFromEnv(configEnv)
  yield* EnvConfig.optionalDecimalInteger(provider, "RIKA_MODEL_CONTEXT_WINDOW", {
    minimum: 1,
    allowLeadingZero: false,
  }).pipe(Effect.mapError(() => invalidRuntimeEnv(configEnv, "RIKA_MODEL_CONTEXT_WINDOW")))
  yield* Effect.try({
    try: () => PermissionPolicy.configFromEnv(configEnv),
    catch: () => invalidRuntimeEnv(configEnv, "RIKA_PERMISSION_MODE"),
  })
})

const componentsFromEnv = (options: Options) => {
  const configLayer = options.configLayer
  const redactorLayer = options.redactorLayer ?? SecretRedactor.layerFromEnv(options.env)
  const settingsLayer = Settings.layerFromEnv(options.env, options.workspaceRoot)
  const diagnosticsLayer =
    options.diagnosticsLayer ??
    Diagnostics.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(redactorLayer))
  const databaseLayer =
    options.databaseMode === "memory" ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const memoryStoreLayer = ThreadMemoryStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(IdGenerator.layer),
  )
  const orbStoreLayer = OrbStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(IdGenerator.layer),
  )
  const llmLayer = Live.layer(Live.optionsFromEnv(options.env)).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const embeddingsLayer = Embeddings.layer(
    Embeddings.optionsFromEnv(options.env, { openaiConfigured: Live.optionsFromEnv(options.env).openai !== undefined }),
  )
  const skillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const pluginLayer = PluginHost.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(PluginUi.silentLayer))
  const permissionConfig = options.permissionConfig ?? PermissionPolicy.defaultConfig
  const storageCoreLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    workspaceStoreLayer,
    memoryStoreLayer,
    projectStoreLayer,
    Migration.layer,
    redactorLayer,
    settingsLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
  )

  return {
    artifactLayer,
    configLayer,
    databaseLayer,
    diagnosticsLayer,
    embeddingsLayer,
    llmLayer,
    orbStoreLayer,
    permissionConfig,
    pluginLayer,
    redactorLayer,
    settingsLayer,
    skillLayer,
    storageCoreLayer,
    timeLayer,
  }
}

type ComponentLayers = ReturnType<typeof componentsFromEnv>
type SharedStorageLayer = Layer.Layer<any, Error>

const invalidRuntimeEnv = (env: Record<string, string | undefined>, key: string) =>
  new Config.ConfigError({
    message: `Invalid ${key} ${env[key] ?? ""}`,
    key,
  })

const runtimeEnvPreflightLayer = (options: Options) =>
  Layer.effectDiscard(validateRuntimeEnv({ env: options.env, workspaceRoot: options.workspaceRoot }))

const withRuntimeEnvPreflight = <A, E, R>(
  preflightLayer: Layer.Layer<never, Config.ConfigError>,
  layer: Layer.Layer<A, E, R>,
): Layer.Layer<A, E | Config.ConfigError, R> => preflightLayer.pipe(Layer.flatMap(() => layer))

const serviceLayersFromStorage = <StorageLayer extends SharedStorageLayer>(
  components: ComponentLayers,
  migratedStorageLayer: StorageLayer,
) => {
  const {
    configLayer,
    diagnosticsLayer,
    embeddingsLayer,
    llmLayer,
    permissionConfig,
    pluginLayer: unprovidedPluginLayer,
    skillLayer,
    timeLayer,
  } = components
  const pluginLayer = unprovidedPluginLayer.pipe(Layer.provideMerge(migratedStorageLayer))
  const storageAndThreadLayer = ThreadService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const threadMemoryLayer = ThreadMemory.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(storageAndThreadLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(timeLayer),
  )
  const contextResolverLayer = ContextResolver.layer.pipe(
    Layer.provide(storageAndThreadLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(embeddingsLayer),
  )
  const specialtyToolLayer = SpecialtyTools.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
  )
  const subagentToolLayer = BuiltInTools.subagentToolExecutorLayerFromPermissionConfig(permissionConfig).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(threadMemoryLayer),
    Layer.provideMerge(pluginLayer),
    Layer.provideMerge(specialtyToolLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const subagentLayer = SubagentRuntime.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
    Layer.provide(subagentToolLayer),
  )
  const toolLayer = BuiltInTools.toolExecutorLayerFromPermissionConfig(permissionConfig).pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(threadMemoryLayer),
    Layer.provideMerge(pluginLayer),
    Layer.provideMerge(specialtyToolLayer),
    Layer.provideMerge(subagentLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const skillToolProviderLayer = BuiltInTools.skillToolProviderLayer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(migratedStorageLayer),
  )
  const memoryIndexerLayer = ThreadMemoryIndexer.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const commonBaseLayer = Layer.mergeAll(
    migratedStorageLayer,
    storageAndThreadLayer,
    workspaceAccessLayer,
    contextResolverLayer,
    skillLayer,
    skillToolProviderLayer,
    toolLayer,
    llmLayer,
    diagnosticsLayer,
  )

  return {
    commonBaseLayer,
    memoryIndexerLayer,
    pluginLayer,
    storageAndThreadLayer,
    threadMemoryLayer,
  }
}

export const fromEnv = (options: Options) => {
  const preflightLayer = runtimeEnvPreflightLayer(options)
  const components = componentsFromEnv(options)
  const storageLayer = components.storageCoreLayer
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const services = serviceLayersFromStorage(components, migratedStorageLayer)
  const baseLayer = services.commonBaseLayer
  const agentLoopLayer = AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))

  return {
    agentLoopLayer: withRuntimeEnvPreflight(preflightLayer, agentLoopLayer),
    artifactLayer: withRuntimeEnvPreflight(preflightLayer, components.artifactLayer),
    baseLayer: withRuntimeEnvPreflight(preflightLayer, baseLayer),
    configLayer: withRuntimeEnvPreflight(preflightLayer, components.configLayer),
    databaseLayer: withRuntimeEnvPreflight(preflightLayer, components.databaseLayer),
    diagnosticsLayer: withRuntimeEnvPreflight(preflightLayer, components.diagnosticsLayer),
    embeddingsLayer: withRuntimeEnvPreflight(preflightLayer, components.embeddingsLayer),
    llmLayer: withRuntimeEnvPreflight(preflightLayer, components.llmLayer),
    migratedStorageLayer: withRuntimeEnvPreflight(preflightLayer, migratedStorageLayer),
    pluginLayer: withRuntimeEnvPreflight(preflightLayer, services.pluginLayer),
    redactorLayer: withRuntimeEnvPreflight(preflightLayer, components.redactorLayer),
    settingsLayer: withRuntimeEnvPreflight(preflightLayer, components.settingsLayer),
    storageAndThreadLayer: withRuntimeEnvPreflight(preflightLayer, services.storageAndThreadLayer),
    storageLayer: withRuntimeEnvPreflight(preflightLayer, storageLayer),
    threadMemoryLayer: withRuntimeEnvPreflight(preflightLayer, services.threadMemoryLayer),
    timeLayer: withRuntimeEnvPreflight(preflightLayer, components.timeLayer),
  }
}

export const fromEnvWithOrbStoreAndMemoryIndexer = (options: Options) => {
  const preflightLayer = runtimeEnvPreflightLayer(options)
  const components = componentsFromEnv(options)
  const storageLayer = Layer.mergeAll(components.storageCoreLayer, components.orbStoreLayer)
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const repairedStorageLayer = Layer.effectDiscard(OrbStore.repairUsageIntervals()).pipe(
    Layer.provide(components.orbStoreLayer),
    Layer.provideMerge(migratedStorageLayer),
  )
  const services = serviceLayersFromStorage(components, repairedStorageLayer)
  const baseLayer = Layer.mergeAll(services.commonBaseLayer, services.memoryIndexerLayer)
  const agentLoopLayer = AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))

  return {
    agentLoopLayer: withRuntimeEnvPreflight(preflightLayer, agentLoopLayer),
    artifactLayer: withRuntimeEnvPreflight(preflightLayer, components.artifactLayer),
    baseLayer: withRuntimeEnvPreflight(preflightLayer, baseLayer),
    configLayer: withRuntimeEnvPreflight(preflightLayer, components.configLayer),
    databaseLayer: withRuntimeEnvPreflight(preflightLayer, components.databaseLayer),
    diagnosticsLayer: withRuntimeEnvPreflight(preflightLayer, components.diagnosticsLayer),
    embeddingsLayer: withRuntimeEnvPreflight(preflightLayer, components.embeddingsLayer),
    llmLayer: withRuntimeEnvPreflight(preflightLayer, components.llmLayer),
    migratedStorageLayer: withRuntimeEnvPreflight(preflightLayer, repairedStorageLayer),
    pluginLayer: withRuntimeEnvPreflight(preflightLayer, services.pluginLayer),
    redactorLayer: withRuntimeEnvPreflight(preflightLayer, components.redactorLayer),
    settingsLayer: withRuntimeEnvPreflight(preflightLayer, components.settingsLayer),
    storageAndThreadLayer: withRuntimeEnvPreflight(preflightLayer, services.storageAndThreadLayer),
    storageLayer: withRuntimeEnvPreflight(preflightLayer, storageLayer),
    threadMemoryLayer: withRuntimeEnvPreflight(preflightLayer, services.threadMemoryLayer),
    timeLayer: withRuntimeEnvPreflight(preflightLayer, components.timeLayer),
  }
}
