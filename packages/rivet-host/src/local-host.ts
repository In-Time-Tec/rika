import { AgentLoop, ContextResolver, SkillRegistry, SubagentRuntime, ThreadService, ToolExecutor } from "@rika/agent"
import { Config, IdGenerator, Time } from "@rika/core"
import { OpenAi, Provider, Router } from "@rika/llm"
import {
  ArtifactStore,
  Database,
  McpApprovalStore,
  Migration,
  ThreadEventLog,
  ThreadProjection,
} from "@rika/persistence"
import { PluginHost, PluginUi } from "@rika/plugin"
import { BuiltInTools, FffSearch, McpClient, SpecialtyTools } from "@rika/tools"
import { Registry } from "@rivetkit/effect"
import { Layer } from "effect"
import { layer as threadActorLayer } from "./thread-live"

export interface Options {
  readonly endpoint?: string
  readonly noWelcome?: boolean
}

export const defaultEndpoint = "http://127.0.0.1:6420"

export const endpointFromEnv = (env: Record<string, string | undefined> = process.env) =>
  env.RIVET_ENDPOINT ?? defaultEndpoint

const configuredDatabaseLayer = Database.layer.pipe(Layer.provideMerge(Config.layer))
const configuredTimeLayer = Time.layer
const configuredArtifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(configuredDatabaseLayer))
const configuredMcpApprovalLayer = McpApprovalStore.layer.pipe(
  Layer.provideMerge(configuredDatabaseLayer),
  Layer.provideMerge(configuredTimeLayer),
)
const configuredLlmLayer = Router.layer.pipe(Layer.provideMerge(OpenAi.layer()), Layer.provideMerge(Config.layer))
const configuredSkillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(Config.layer))
const configuredPluginLayer = PluginHost.layer.pipe(
  Layer.provideMerge(Config.layer),
  Layer.provideMerge(PluginUi.silentLayer),
)
const storageLayer = Layer.mergeAll(
  Config.layer,
  configuredDatabaseLayer,
  configuredArtifactLayer,
  configuredMcpApprovalLayer,
  Migration.layer,
  ThreadEventLog.layer,
  ThreadProjection.layer,
  configuredTimeLayer,
  IdGenerator.layer,
)
const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
const storageAndThreadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
const configuredContextResolverLayer = ContextResolver.layer.pipe(Layer.provide(storageAndThreadLayer))
const configuredReadOnlyToolLayer = BuiltInTools.readOnlyToolExecutorLayer.pipe(Layer.provideMerge(Config.layer))
const configuredSubagentLayer = SubagentRuntime.layer.pipe(
  Layer.provideMerge(migratedStorageLayer),
  Layer.provideMerge(configuredLlmLayer),
  Layer.provideMerge(configuredReadOnlyToolLayer),
)
const configuredSpecialtyToolLayer = SpecialtyTools.layer.pipe(
  Layer.provideMerge(migratedStorageLayer),
  Layer.provideMerge(configuredLlmLayer),
)
const configuredToolLayer = BuiltInTools.toolExecutorLayer.pipe(
  Layer.provideMerge(migratedStorageLayer),
  Layer.provideMerge(configuredPluginLayer),
  Layer.provideMerge(configuredSpecialtyToolLayer),
  Layer.provideMerge(configuredSubagentLayer),
)

type ServiceLayerOutput =
  | AgentLoop.Service
  | ArtifactStore.Service
  | Config.Service
  | ContextResolver.Service
  | Database.Service
  | IdGenerator.Service
  | Migration.Service
  | McpApprovalStore.Service
  | PluginHost.Service
  | Provider.Service
  | Router.Service
  | SkillRegistry.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | ThreadEventLog.Service
  | ThreadProjection.Service
  | ThreadService.Service
  | Time.Service
  | ToolExecutor.Service

type ServiceLayerError =
  | Config.ConfigError
  | ContextResolver.ContextResolverError
  | Database.DatabaseError
  | FffSearch.FffSearchError
  | McpApprovalStore.McpApprovalStoreError
  | McpClient.RunError
  | Migration.MigrationError
  | PluginHost.RunError

const baseServiceLayer = Layer.mergeAll(
  storageAndThreadLayer,
  configuredContextResolverLayer,
  configuredSkillLayer,
  configuredToolLayer,
  configuredLlmLayer,
)

export const serviceLayer: Layer.Layer<ServiceLayerOutput, ServiceLayerError> = AgentLoop.layer.pipe(
  Layer.provideMerge(baseServiceLayer),
)

export const supportLayer: Layer.Layer<ServiceLayerOutput, ServiceLayerError> = serviceLayer

export const actorsLayer = () => threadActorLayer.pipe(Layer.provide(supportLayer))

export const layer = (options: Options = {}) => {
  const endpoint = options.endpoint ?? endpointFromEnv()
  return Registry.serve(actorsLayer()).pipe(
    Layer.provide(Registry.layer({ endpoint, noWelcome: options.noWelcome ?? true })),
  )
}
