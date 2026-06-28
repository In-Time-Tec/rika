import {
  AgentLoop,
  CheckRegistry,
  ContextResolver,
  ReviewService,
  SkillRegistry,
  SubagentRuntime,
  ThreadService,
  ToolExecutor,
} from "@rika/agent"
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
import { Session, Terminal } from "@rika/tui"
import { Effect, Layer } from "effect"
import * as Args from "./args"
import * as Execute from "./execute"
import * as Mcp from "./mcp"
import * as Output from "./output"
import * as Review from "./review"
import * as Skills from "./skills"
import * as Threads from "./threads"

export interface ProcessInput {
  readonly argv: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
  readonly cwd: string
}

export const runProcess: (input: ProcessInput) => Effect.Effect<number, never, Output.Service> = Effect.fn(
  "Cli.Runtime.runProcess",
)((input) =>
  Args.parse(input.argv).pipe(
    Effect.matchEffect({
      onFailure: (error: Args.ArgsError) => Output.stderr(Execute.formatError(error)).pipe(Effect.as(error.exit_code)),
      onSuccess: (command) =>
        (command.type === "execute"
          ? Execute.executeCommand(command).pipe(Effect.provide(liveLayer(command, input.env, input.cwd)))
          : command.type === "interactive"
            ? Session.run(command).pipe(Effect.provide(interactiveLiveLayer(command, input.env, input.cwd)))
            : command.type === "threads"
              ? Threads.executeCommand(command).pipe(Effect.provide(threadsLiveLayer(command, input.env, input.cwd)))
              : command.type === "skills"
                ? Skills.executeCommand(command).pipe(Effect.provide(skillsLiveLayer(command, input.env, input.cwd)))
                : command.type === "mcp"
                  ? Mcp.executeCommand(command).pipe(Effect.provide(mcpLiveLayer(command, input.env, input.cwd)))
                  : Review.executeCommand(command).pipe(Effect.provide(reviewLiveLayer(command, input.env, input.cwd)))
        ).pipe(
          Effect.matchEffect({
            onFailure: (error: RuntimeError) => Output.stderr(formatRuntimeError(error)).pipe(Effect.as(1)),
            onSuccess: (code) => Effect.succeed(code),
          }),
        ),
    }),
  ),
)

type RuntimeError =
  | AgentLoop.RunError
  | ArtifactStore.ArtifactStoreError
  | CheckRegistry.CheckRegistryError
  | ContextResolver.ContextResolverError
  | Config.ConfigError
  | Database.DatabaseError
  | Execute.ExecuteError
  | FffSearch.FffSearchError
  | Mcp.McpError
  | McpApprovalStore.McpApprovalStoreError
  | McpClient.McpClientError
  | Migration.MigrationError
  | PluginHost.RunError
  | Review.ReviewError
  | ReviewService.ReviewServiceError
  | Session.SessionError
  | SkillRegistry.SkillRegistryError
  | SubagentRuntime.RunError
  | Skills.SkillsError
  | Terminal.TerminalError
  | ThreadService.ThreadServiceError
  | ThreadEventLog.ThreadEventLogError
  | ThreadProjection.ThreadProjectionError
  | Threads.ThreadsError

const formatRuntimeError = (error: RuntimeError) => {
  if (error instanceof Migration.MigrationError) return `Rika failed: ${error.message}`
  if (error instanceof FffSearch.FffSearchError) return `Rika failed: ${error.message}`
  if (error instanceof Mcp.McpError) return Mcp.formatError(error)
  if (error instanceof McpApprovalStore.McpApprovalStoreError) return `Rika failed: ${error.message}`
  if (error instanceof McpClient.McpClientError) return `Rika failed: ${error.message}`
  if (error instanceof Review.ReviewError) return Review.formatError(error)
  if (error instanceof ReviewService.ReviewServiceError) return `Rika failed: ${error.message}`
  if (error instanceof ArtifactStore.ArtifactStoreError) return `Rika failed: ${error.message}`
  if (error instanceof CheckRegistry.CheckRegistryError) return `Rika failed: ${error.message}`
  if (error instanceof SubagentRuntime.SubagentRuntimeError) return `Rika failed: ${error.message}`
  if (error instanceof PluginHost.PluginHostError) return `Rika failed: ${error.message}`
  if (error instanceof PluginUi.PluginUiError) return `Rika failed: ${error.message}`
  if (error instanceof ContextResolver.ContextResolverError) return `Rika failed: ${error.message}`
  if (error instanceof Config.ConfigError) return `Rika failed: ${error.message}`
  if (error instanceof Database.DatabaseError) return `Rika failed: ${error.message}`
  if (error instanceof Session.SessionError) return `Rika failed: ${error.message}`
  if (error instanceof SkillRegistry.SkillRegistryError) return `Rika failed: ${error.message}`
  if (error instanceof Skills.SkillsError) return Skills.formatError(error)
  if (error instanceof Terminal.TerminalError) return `Rika failed: ${error.message}`
  if (error instanceof ThreadService.ThreadServiceError) return `Rika failed: ${error.message}`
  if (error instanceof ThreadEventLog.ThreadEventLogError) return `Rika failed: ${error.message}`
  if (error instanceof ThreadProjection.ThreadProjectionError) return `Rika failed: ${error.message}`
  if (error instanceof Threads.ThreadsError) return Threads.formatError(error)
  return Execute.formatError(error)
}

export const liveLayer = (
  command: Args.ExecuteCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<LiveLayerOutput, LiveLayerError> => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: command.mode ?? "smart",
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const llmLayer = Router.layer.pipe(Layer.provideMerge(OpenAi.layer()), Layer.provideMerge(configLayer))
  const pluginLayer = PluginHost.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(PluginUi.silentLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const readOnlyToolLayer = BuiltInTools.readOnlyToolExecutorLayer.pipe(Layer.provideMerge(configLayer))
  const subagentLayer = SubagentRuntime.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
    Layer.provideMerge(readOnlyToolLayer),
  )
  const specialtyToolLayer = SpecialtyTools.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
  )
  const toolLayer = BuiltInTools.toolExecutorLayer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(pluginLayer),
    Layer.provideMerge(specialtyToolLayer),
    Layer.provideMerge(subagentLayer),
  )
  const skillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const storageAndThreadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const contextResolverLayer = ContextResolver.layer.pipe(Layer.provide(storageAndThreadLayer))
  const baseLayer = Layer.mergeAll(
    Output.layer,
    storageAndThreadLayer,
    contextResolverLayer,
    skillLayer,
    toolLayer,
    llmLayer,
  )
  const commandLayer = Execute.layer.pipe(Layer.provideMerge(AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))))

  return commandLayer
}

export const interactiveLiveLayer = (
  command: Args.InteractiveCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<InteractiveLayerOutput, LiveLayerError> => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: command.mode ?? "smart",
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const llmLayer = Router.layer.pipe(Layer.provideMerge(OpenAi.layer()), Layer.provideMerge(configLayer))
  const pluginLayer = PluginHost.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(PluginUi.silentLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const readOnlyToolLayer = BuiltInTools.readOnlyToolExecutorLayer.pipe(Layer.provideMerge(configLayer))
  const subagentLayer = SubagentRuntime.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
    Layer.provideMerge(readOnlyToolLayer),
  )
  const specialtyToolLayer = SpecialtyTools.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
  )
  const toolLayer = BuiltInTools.toolExecutorLayer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(pluginLayer),
    Layer.provideMerge(specialtyToolLayer),
    Layer.provideMerge(subagentLayer),
  )
  const skillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const checkLayer = CheckRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const reviewServiceLayer = ReviewService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(checkLayer),
    Layer.provideMerge(subagentLayer),
  )
  const storageAndThreadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const contextResolverLayer = ContextResolver.layer.pipe(Layer.provide(storageAndThreadLayer))
  const baseLayer = Layer.mergeAll(
    Terminal.layer,
    storageAndThreadLayer,
    contextResolverLayer,
    reviewServiceLayer,
    skillLayer,
    toolLayer,
    llmLayer,
  )
  const sessionLayer = Session.layer.pipe(Layer.provideMerge(AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))))

  return sessionLayer
}

export const skillsLiveLayer = (
  _command: Args.SkillCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<SkillsLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: env.RIKA_MODE === "rush" || env.RIKA_MODE === "deep" ? env.RIKA_MODE : "smart",
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )

  return Skills.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(SkillRegistry.layer),
    Layer.provideMerge(configLayer),
  )
}

export const threadsLiveLayer = (
  _command: Args.ThreadCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<ThreadsLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: env.RIKA_MODE === "rush" || env.RIKA_MODE === "deep" ? env.RIKA_MODE : "smart",
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    Output.layer,
    databaseLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    Time.layer,
    IdGenerator.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const storageAndThreadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const commandLayer = Threads.layer.pipe(Layer.provideMerge(storageAndThreadLayer))

  return commandLayer
}

export const mcpLiveLayer = (
  _command: Args.McpCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<McpLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: env.RIKA_MODE === "rush" || env.RIKA_MODE === "deep" ? env.RIKA_MODE : "smart",
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    Output.layer,
    databaseLayer,
    Migration.layer,
    timeLayer,
    mcpApprovalLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const mcpClientLayer = McpClient.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const commandLayer = Mcp.layer.pipe(Layer.provideMerge(migratedStorageLayer), Layer.provideMerge(mcpClientLayer))

  return commandLayer
}

export const reviewLiveLayer = (
  command: Args.ReviewCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<ReviewLayerOutput, LiveLayerError> => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: env.RIKA_MODE === "rush" || env.RIKA_MODE === "deep" ? env.RIKA_MODE : "smart",
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    Output.layer,
    databaseLayer,
    Migration.layer,
    timeLayer,
    IdGenerator.layer,
    artifactLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const llmLayer = Router.layer.pipe(Layer.provideMerge(OpenAi.layer()), Layer.provideMerge(configLayer))
  const readOnlyToolLayer = BuiltInTools.readOnlyToolExecutorLayer.pipe(Layer.provideMerge(configLayer))
  const subagentLayer = SubagentRuntime.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
    Layer.provideMerge(readOnlyToolLayer),
  )
  const reviewServiceLayer = ReviewService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(CheckRegistry.layer.pipe(Layer.provideMerge(configLayer))),
    Layer.provideMerge(subagentLayer),
  )
  const commandLayer = Review.layer.pipe(Layer.provideMerge(Output.layer), Layer.provideMerge(reviewServiceLayer))

  return commandLayer
}

export type LiveLayerOutput =
  | AgentLoop.Service
  | ArtifactStore.Service
  | Config.Service
  | ContextResolver.Service
  | Database.Service
  | Execute.Service
  | IdGenerator.Service
  | Migration.Service
  | McpApprovalStore.Service
  | Output.Service
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

export type InteractiveLayerOutput =
  | AgentLoop.Service
  | ArtifactStore.Service
  | CheckRegistry.Service
  | Config.Service
  | ContextResolver.Service
  | Database.Service
  | IdGenerator.Service
  | Migration.Service
  | McpApprovalStore.Service
  | PluginHost.Service
  | Provider.Service
  | ReviewService.Service
  | Router.Service
  | Session.Service
  | SkillRegistry.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | Terminal.Service
  | ThreadEventLog.Service
  | ThreadProjection.Service
  | ThreadService.Service
  | Time.Service
  | ToolExecutor.Service

export type ThreadsLayerOutput =
  | Config.Service
  | Database.Service
  | IdGenerator.Service
  | Migration.Service
  | Output.Service
  | ThreadEventLog.Service
  | ThreadProjection.Service
  | ThreadService.Service
  | Threads.Service
  | Time.Service

export type SkillsLayerOutput = Config.Service | Output.Service | SkillRegistry.Service | Skills.Service

export type McpLayerOutput =
  | Config.Service
  | Database.Service
  | Mcp.Service
  | McpApprovalStore.Service
  | McpClient.Service
  | Migration.Service
  | Output.Service
  | Time.Service

export type ReviewLayerOutput =
  | ArtifactStore.Service
  | CheckRegistry.Service
  | Config.Service
  | Database.Service
  | IdGenerator.Service
  | Migration.Service
  | Output.Service
  | Provider.Service
  | Review.Service
  | ReviewService.Service
  | Router.Service
  | SubagentRuntime.Service
  | Time.Service
  | ToolExecutor.Service

export type LiveLayerError =
  | Config.ConfigError
  | ContextResolver.ContextResolverError
  | Database.DatabaseError
  | FffSearch.FffSearchError
  | McpApprovalStore.McpApprovalStoreError
  | McpClient.RunError
  | Migration.MigrationError
  | PluginHost.RunError
  | ReviewService.RunError
