import {
  AgentLoop,
  ContextResolver,
  SkillRegistry,
  SkillToolProvider,
  SubagentRuntime,
  ThreadMemory,
  ThreadService,
  ToolExecutor,
  WorkspaceAccess,
} from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Settings, Time } from "@rika/core"
import { Embeddings, Live, Router } from "@rika/llm"
import {
  ArtifactStore,
  Database,
  McpApprovalStore,
  Migration,
  ProjectStore,
  ThreadEventLog,
  ThreadMemoryStore,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { PluginHost, PluginUi } from "@rika/plugin"
import { BuiltInTools, FffSearch, McpClient, SpecialtyTools } from "@rika/tools"
import { Client, Registry } from "@rivetkit/effect"
import { Effect, Layer } from "effect"
import * as HostConfig from "./host-config"
import * as ThreadClient from "./thread-client"
import { layer as threadActorLayer } from "./thread-live"

export interface Options extends HostConfig.ResolveOptions {}

export const defaultEndpoint = HostConfig.defaultLocalEndpoint

export const endpointFromEnv = (env: Record<string, string | undefined> = process.env) =>
  env.RIKA_RIVET_ENDPOINT ?? env.RIVET_ENDPOINT ?? defaultEndpoint

const configuredTimeLayer = Time.layer

type ServiceLayerOutput =
  | AgentLoop.Service
  | ArtifactStore.Service
  | Config.Service
  | ContextResolver.Service
  | Database.Service
  | Diagnostics.Service
  | IdGenerator.Service
  | Migration.Service
  | McpApprovalStore.Service
  | PluginHost.Service
  | ProjectStore.Service
  | Router.Service
  | SecretRedactor.Service
  | Settings.Service
  | SkillRegistry.Service
  | SkillToolProvider.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | ThreadEventLog.Service
  | ThreadMemory.Service
  | ThreadMemoryStore.Service
  | ThreadProjection.Service
  | ThreadService.Service
  | Time.Service
  | ToolExecutor.Service
  | WorkspaceAccess.Service
  | WorkspaceStore.Service

type ServiceLayerError =
  | Config.ConfigError
  | ContextResolver.ContextResolverError
  | Database.DatabaseError
  | FffSearch.FffSearchError
  | McpApprovalStore.McpApprovalStoreError
  | McpClient.RunError
  | Migration.MigrationError
  | PluginHost.RunError
  | ProjectStore.ProjectStoreError

export const serviceLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): Layer.Layer<ServiceLayerOutput, ServiceLayerError> => {
  const configLayer = Config.layerFromEnv(env, cwd)
  const redactorLayer = SecretRedactor.layerFromEnv(env)
  const configuredSettingsLayer = Settings.layerFromEnv(env, cwd)
  const configuredDatabaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const configuredArtifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(configuredDatabaseLayer))
  const configuredMcpApprovalLayer = McpApprovalStore.layer.pipe(
    Layer.provideMerge(configuredDatabaseLayer),
    Layer.provideMerge(configuredTimeLayer),
  )
  const configuredWorkspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(configuredDatabaseLayer))
  const configuredMemoryStoreLayer = ThreadMemoryStore.layer.pipe(Layer.provideMerge(configuredDatabaseLayer))
  const configuredProjectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(configuredDatabaseLayer),
    Layer.provideMerge(configuredTimeLayer),
    Layer.provideMerge(IdGenerator.layer),
  )
  const configuredLlmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(Layer.provideMerge(configLayer))
  const configuredEmbeddingsLayer = Embeddings.layer(
    Embeddings.optionsFromEnv(env, { openaiConfigured: Live.optionsFromEnv(env).openai !== undefined }),
  )
  const configuredSkillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const configuredDiagnosticsLayer = Diagnostics.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(redactorLayer),
  )
  const configuredPluginLayer = PluginHost.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(PluginUi.silentLayer),
  )
  const storageLayer = Layer.mergeAll(
    configLayer,
    configuredDatabaseLayer,
    configuredArtifactLayer,
    configuredMcpApprovalLayer,
    Migration.layer,
    redactorLayer,
    configuredSettingsLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    configuredMemoryStoreLayer,
    configuredProjectStoreLayer,
    ThreadProjection.layer,
    configuredWorkspaceStoreLayer,
    configuredTimeLayer,
    IdGenerator.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const storageAndThreadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const configuredWorkspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const configuredThreadMemoryLayer = ThreadMemory.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(storageAndThreadLayer),
    Layer.provideMerge(configuredEmbeddingsLayer),
    Layer.provideMerge(configuredTimeLayer),
  )
  const configuredContextResolverLayer = ContextResolver.layer.pipe(
    Layer.provide(storageAndThreadLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(configuredEmbeddingsLayer),
  )
  const configuredSpecialtyToolLayer = SpecialtyTools.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(configuredLlmLayer),
  )
  const configuredSubagentToolLayer = BuiltInTools.subagentToolExecutorLayer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(configuredThreadMemoryLayer),
    Layer.provideMerge(configuredPluginLayer),
    Layer.provideMerge(configuredSpecialtyToolLayer),
  )
  const configuredSubagentLayer = SubagentRuntime.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(configuredLlmLayer),
    Layer.provideMerge(configuredSubagentToolLayer),
  )
  const configuredToolLayer = BuiltInTools.toolExecutorLayer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(configuredThreadMemoryLayer),
    Layer.provideMerge(configuredPluginLayer),
    Layer.provideMerge(configuredSpecialtyToolLayer),
    Layer.provideMerge(configuredSubagentLayer),
  )
  const configuredSkillToolProviderLayer = BuiltInTools.skillToolProviderLayer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(migratedStorageLayer),
  )
  const baseServiceLayer = Layer.mergeAll(
    storageAndThreadLayer,
    configuredWorkspaceAccessLayer,
    configuredContextResolverLayer,
    configuredSkillLayer,
    configuredSkillToolProviderLayer,
    configuredToolLayer,
    configuredLlmLayer,
    configuredDiagnosticsLayer,
  )

  return AgentLoop.layer.pipe(Layer.provideMerge(baseServiceLayer))
}

export const serviceLayer: Layer.Layer<ServiceLayerOutput, ServiceLayerError> = serviceLayerFromEnv()

export const supportLayer: Layer.Layer<ServiceLayerOutput, ServiceLayerError> = serviceLayer

export const supportLayerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): Layer.Layer<ServiceLayerOutput, ServiceLayerError> => serviceLayerFromEnv(env, cwd)

export const actorsLayerFromEnv = (env: Record<string, string | undefined> = process.env, cwd = process.cwd()) =>
  threadActorLayer.pipe(Layer.provide(supportLayerFromEnv(env, cwd)))

export const actorsLayer = () => actorsLayerFromEnv()

export const clientLayer = (options: Options = {}) =>
  Layer.unwrap(
    HostConfig.resolveOptions(options).pipe(Effect.map((host) => Client.layer(HostConfig.toClientOptions(host)))),
  )

export const threadClientLayer = (options: Options = {}) => ThreadClient.layer.pipe(Layer.provide(clientLayer(options)))

export const layerFromEnv = (
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
  options: Options = {},
) =>
  Layer.unwrap(
    HostConfig.resolveOptions(options, env).pipe(
      Effect.map((host) =>
        Registry.serve(actorsLayerFromEnv(env, cwd)).pipe(
          Layer.provide(Registry.layer(HostConfig.toRegistryOptions(host))),
        ),
      ),
    ),
  )

export const layer = (options: Options = {}) => layerFromEnv(process.env, process.cwd(), options)
