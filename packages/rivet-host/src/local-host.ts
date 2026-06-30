import {
  AgentLoop,
  ContextResolver,
  SkillRegistry,
  SubagentRuntime,
  ThreadService,
  ToolExecutor,
  WorkspaceAccess,
} from "@rika/agent"
import { Config, Diagnostics, IdGenerator, Time } from "@rika/core"
import { Live, Router } from "@rika/llm"
import {
  ArtifactStore,
  Database,
  McpApprovalStore,
  Migration,
  ThreadEventLog,
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

const configuredDatabaseLayer = Database.layer.pipe(Layer.provideMerge(Config.layer))
const configuredTimeLayer = Time.layer
const configuredArtifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(configuredDatabaseLayer))
const configuredMcpApprovalLayer = McpApprovalStore.layer.pipe(
  Layer.provideMerge(configuredDatabaseLayer),
  Layer.provideMerge(configuredTimeLayer),
)
const configuredWorkspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(configuredDatabaseLayer))
const configuredLlmLayer = Live.layer(Live.optionsFromEnv(process.env)).pipe(Layer.provideMerge(Config.layer))
const configuredSkillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(Config.layer))
const configuredDiagnosticsLayer = Diagnostics.layer.pipe(Layer.provideMerge(Config.layer))
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
  configuredWorkspaceStoreLayer,
  configuredTimeLayer,
  IdGenerator.layer,
)
const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
const storageAndThreadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
const configuredWorkspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
const configuredContextResolverLayer = ContextResolver.layer.pipe(Layer.provide(storageAndThreadLayer))
const configuredSubagentToolLayer = BuiltInTools.subagentToolExecutorLayer.pipe(Layer.provideMerge(Config.layer))
const configuredSubagentLayer = SubagentRuntime.layer.pipe(
  Layer.provideMerge(migratedStorageLayer),
  Layer.provideMerge(configuredLlmLayer),
  Layer.provideMerge(configuredSubagentToolLayer),
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
  | Diagnostics.Service
  | IdGenerator.Service
  | Migration.Service
  | McpApprovalStore.Service
  | PluginHost.Service
  | Router.Service
  | SkillRegistry.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | ThreadEventLog.Service
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

const baseServiceLayer = Layer.mergeAll(
  storageAndThreadLayer,
  configuredWorkspaceAccessLayer,
  configuredContextResolverLayer,
  configuredSkillLayer,
  configuredToolLayer,
  configuredLlmLayer,
  configuredDiagnosticsLayer,
)

export const serviceLayer: Layer.Layer<ServiceLayerOutput, ServiceLayerError> = AgentLoop.layer.pipe(
  Layer.provideMerge(baseServiceLayer),
)

export const supportLayer: Layer.Layer<ServiceLayerOutput, ServiceLayerError> = serviceLayer

export const actorsLayer = () => threadActorLayer.pipe(Layer.provide(supportLayer))

export const clientLayer = (options: Options = {}) =>
  Layer.unwrap(
    HostConfig.resolveOptions(options).pipe(Effect.map((host) => Client.layer(HostConfig.toClientOptions(host)))),
  )

export const threadClientLayer = (options: Options = {}) => ThreadClient.layer.pipe(Layer.provide(clientLayer(options)))

export const layer = (options: Options = {}) =>
  Layer.unwrap(
    HostConfig.resolveOptions(options).pipe(
      Effect.map((host) =>
        Registry.serve(actorsLayer()).pipe(Layer.provide(Registry.layer(HostConfig.toRegistryOptions(host)))),
      ),
    ),
  )
