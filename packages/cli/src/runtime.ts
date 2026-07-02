import {
  AgentLoop,
  CheckRegistry,
  ContextResolver,
  PermissionPolicy,
  ReviewService,
  SkillRegistry,
  SubagentRuntime,
  ThreadService,
  ToolExecutor,
  WorkspaceAccess,
  WorkspaceIdentity,
} from "@rika/agent"
import { Config, Diagnostics, IdGenerator, Telemetry, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { Live, Router } from "@rika/llm"
import { OrbManager, SandboxClient } from "@rika/orb"
import {
  ArtifactStore,
  Database,
  McpApprovalStore,
  Migration,
  OrbStore,
  ProjectStore,
  ThreadEventLog,
  ThreadProjection,
  WorkspaceStore,
} from "@rika/persistence"
import { PluginHost, PluginUi, SelfExtension } from "@rika/plugin"
import { Client } from "@rika/sdk"
import { HttpServer, OrbMirror, RemoteControl, ThreadLive } from "@rika/server"
import { BuiltInTools, FffSearch, McpClient, SpecialtyTools } from "@rika/tools"
import type { Adapter, RemoteSession, Session, Ticker } from "@rika/tui"
import { Effect, Layer, Schedule, Stream } from "effect"
import * as Args from "./args"
import * as CliConfig from "./config"
import * as Doctor from "./doctor"
import * as Execute from "./execute"
import * as Extensions from "./extensions"
import * as Help from "./help"
import * as Ide from "./ide"
import * as Input from "./input"
import * as LocalBackend from "./local-backend"
import * as Mcp from "./mcp"
import * as OrbExecute from "./orb-execute"
import * as Output from "./output"
import * as Project from "./project"
import * as Review from "./review"
import * as RuntimeEnv from "./runtime-env"
import * as Server from "./server"
import * as Skills from "./skills"
import * as Threads from "./threads"
import * as Version from "./version"

export interface ProcessInput {
  readonly argv: ReadonlyArray<string>
  readonly env: Record<string, string | undefined>
  readonly cwd: string
}

type TuiModule = typeof import("@rika/tui")

export const runProcess: (input: ProcessInput) => Effect.Effect<number, never, Output.Service> = Effect.fn(
  "Cli.Runtime.runProcess",
)((input) =>
  RuntimeEnv.load(input).pipe(
    Effect.matchEffect({
      onFailure: (error) => Output.stderr(RuntimeEnv.formatError(error)).pipe(Effect.as(1)),
      onSuccess: (env) =>
        Args.parse(input.argv).pipe(
          Effect.matchEffect({
            onFailure: (error: Args.ArgsError) =>
              Output.stderr(Execute.formatError(error)).pipe(Effect.as(error.exit_code)),
            onSuccess: (command) =>
              (command.type === "invalid_execute_alias"
                ? Output.stderrRaw(Args.invalidExecuteAliasErrorText).pipe(Effect.as(1))
                : command.type === "help"
                  ? Help.executeCommand(command)
                  : command.type === "version"
                    ? Version.executeCommand(command)
                    : command.type === "execute"
                      ? command.orb
                        ? OrbExecute.executeCommand(command).pipe(
                            Effect.provide(orbExecuteLiveLayer(command, env, input.cwd)),
                          )
                        : Execute.executeCommand(command).pipe(Effect.provide(liveLayer(command, env, input.cwd)))
                      : command.type === "interactive"
                        ? command.orb
                          ? Output.stderr("orb interactive mode arrives with #49").pipe(Effect.as(2))
                          : runInteractiveCommand(command, env, input.cwd)
                        : command.type === "threads"
                          ? Threads.executeCommand(command).pipe(
                              Effect.provide(threadsLiveLayer(command, env, input.cwd)),
                            )
                          : command.type === "project"
                            ? Project.executeCommand(command).pipe(
                                Effect.provide(projectLiveLayer(command, env, input.cwd)),
                              )
                            : command.type === "skills"
                              ? Skills.executeCommand(command).pipe(
                                  Effect.provide(skillsLiveLayer(command, env, input.cwd)),
                                )
                              : command.type === "mcp"
                                ? Mcp.executeCommand(command).pipe(
                                    Effect.provide(mcpLiveLayer(command, env, input.cwd)),
                                  )
                                : command.type === "config"
                                  ? CliConfig.executeCommand(command)
                                  : command.type === "review"
                                    ? Review.executeCommand(command).pipe(
                                        Effect.provide(reviewLiveLayer(command, env, input.cwd)),
                                      )
                                    : command.type === "extensions"
                                      ? Extensions.executeCommand(command).pipe(
                                          Effect.provide(extensionsLiveLayer(command, env, input.cwd)),
                                        )
                                      : command.type === "ide"
                                        ? Ide.executeCommand(command).pipe(
                                            Effect.provide(ideLiveLayer(command, env, input.cwd)),
                                          )
                                        : command.type === "doctor"
                                          ? Doctor.executeCommand(command).pipe(
                                              Effect.provide(doctorLiveLayer(env, input.cwd)),
                                            )
                                          : Server.executeCommand(command).pipe(
                                              Effect.provide(serverLiveLayer(command, env, input.cwd)),
                                            )
              ).pipe(
                Effect.matchEffect({
                  onFailure: (error: RuntimeError) =>
                    Output.stderr(formatRuntimeError(error)).pipe(Effect.as(runtimeExitCode(error))),
                  onSuccess: (code) => Effect.succeed(code),
                }),
              ),
          }),
        ),
    }),
  ),
)

const runInteractiveCommand = (
  command: Args.InteractiveCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Effect.Effect<number, RuntimeError> =>
  loadTui().pipe(
    Effect.flatMap((tui) => {
      if (command.ephemeral) {
        return tui.Session.run(command).pipe(
          Effect.provide(interactiveLiveLayerFromTui(command, env, cwd, tui)),
        ) as Effect.Effect<number, RuntimeError>
      }
      return tui.RemoteSession.run(command).pipe(
        Effect.provide(interactiveRemoteLiveLayerFromTui(command, env, cwd, tui)),
      ) as Effect.Effect<number, RuntimeError>
    }),
  )

const loadTui = (): Effect.Effect<TuiModule> => Effect.promise(() => import("@rika/tui"))

type RuntimeError =
  | AgentLoop.RunError
  | ArtifactStore.ArtifactStoreError
  | CheckRegistry.CheckRegistryError
  | ContextResolver.ContextResolverError
  | Config.ConfigError
  | Database.DatabaseError
  | Doctor.DoctorError
  | Execute.ExecuteError
  | Extensions.ExtensionsError
  | FffSearch.FffSearchError
  | Client.SdkError
  | Ide.IdeError
  | IdeBridge.IdeBridgeError
  | LocalBackend.BackendError
  | Mcp.McpError
  | McpApprovalStore.McpApprovalStoreError
  | McpClient.McpClientError
  | Migration.MigrationError
  | OrbMirror.OrbMirrorError
  | OrbExecute.OrbExecuteError
  | OrbManager.OrbProvisionError
  | OrbStore.OrbStoreError
  | PluginHost.RunError
  | Project.ProjectError
  | ProjectStore.ProjectStoreError
  | Review.ReviewError
  | ReviewService.ReviewServiceError
  | RemoteControl.RemoteControlError
  | RemoteSession.RemoteSessionError
  | Server.ServerError
  | SandboxClient.OrbConfigError
  | HttpServer.HttpServerError
  | Session.SessionError
  | SelfExtension.SelfExtensionError
  | SkillRegistry.SkillRegistryError
  | SubagentRuntime.RunError
  | Skills.SkillsError
  | ThreadService.ThreadServiceError
  | ThreadEventLog.ThreadEventLogError
  | ThreadProjection.ThreadProjectionError
  | Threads.ThreadsError
  | WorkspaceAccess.RunError
  | WorkspaceStore.WorkspaceStoreError

const formatRuntimeError = (error: RuntimeError) => {
  if (error instanceof Migration.MigrationError) return `Rika failed: ${error.message}`
  if (error instanceof Extensions.ExtensionsError) return Extensions.formatError(error)
  if (error instanceof FffSearch.FffSearchError) return `Rika failed: ${error.message}`
  if (error instanceof Client.SdkError) return `Rika failed: ${error.message}`
  if (error instanceof Ide.IdeError) return Ide.formatError(error)
  if (error instanceof IdeBridge.IdeBridgeError) return `Rika failed: ${error.message}`
  if (error instanceof LocalBackend.BackendError) return `Rika failed: ${error.message}`
  if (error instanceof Mcp.McpError) return Mcp.formatError(error)
  if (error instanceof McpApprovalStore.McpApprovalStoreError) return `Rika failed: ${error.message}`
  if (error instanceof McpClient.McpClientError) return `Rika failed: ${error.message}`
  if (error instanceof OrbMirror.OrbMirrorError) return `Rika failed: ${error.message}`
  if (error instanceof OrbExecute.OrbExecuteError) return OrbExecute.formatError(error)
  if (error instanceof OrbManager.OrbProvisionError) return `Rika failed: ${error.message}`
  if (error instanceof OrbStore.OrbStoreError) return `Rika failed: ${error.message}`
  if (error instanceof Review.ReviewError) return Review.formatError(error)
  if (error instanceof ReviewService.ReviewServiceError) return `Rika failed: ${error.message}`
  if (error instanceof RemoteControl.RemoteControlError) return `Rika failed: ${error.message}`
  if (error instanceof Server.ServerError) return Server.formatError(error)
  if (error instanceof SandboxClient.OrbConfigError) return `Rika failed: ${error.message}`
  if (error instanceof HttpServer.HttpServerError) return `Rika failed: ${error.message}`
  if (error instanceof ArtifactStore.ArtifactStoreError) return `Rika failed: ${error.message}`
  if (error instanceof CheckRegistry.CheckRegistryError) return `Rika failed: ${error.message}`
  if (error instanceof SubagentRuntime.SubagentRuntimeError) return `Rika failed: ${error.message}`
  if (error instanceof PluginHost.PluginHostError) return `Rika failed: ${error.message}`
  if (error instanceof PluginUi.PluginUiError) return `Rika failed: ${error.message}`
  if (error instanceof Project.ProjectError) return Project.formatError(error)
  if (error instanceof ProjectStore.ProjectStoreError) return `Rika failed: ${error.message}`
  if (error instanceof ContextResolver.ContextResolverError) return `Rika failed: ${error.message}`
  if (error instanceof Config.ConfigError) return `Rika failed: ${error.message}`
  if (error instanceof Database.DatabaseError) return `Rika failed: ${error.message}`
  if (error instanceof Doctor.DoctorError) return Doctor.formatError(error)
  if (tagged(error, "RemoteSessionError")) return `Rika failed: ${error.message}`
  if (tagged(error, "SessionError")) return `Rika failed: ${error.message}`
  if (error instanceof SelfExtension.SelfExtensionError) return `Rika failed: ${error.message}`
  if (error instanceof SkillRegistry.SkillRegistryError) return `Rika failed: ${error.message}`
  if (error instanceof Skills.SkillsError) return Skills.formatError(error)
  if (error instanceof ThreadService.ThreadServiceError) return `Rika failed: ${error.message}`
  if (error instanceof ThreadEventLog.ThreadEventLogError) return `Rika failed: ${error.message}`
  if (error instanceof ThreadProjection.ThreadProjectionError) return `Rika failed: ${error.message}`
  if (error instanceof Threads.ThreadsError) return Threads.formatError(error)
  if (error instanceof WorkspaceAccess.WorkspaceAccessDenied) return `Rika failed: ${error.message}`
  if (error instanceof WorkspaceAccess.WorkspaceAccessError) return `Rika failed: ${error.message}`
  if (error instanceof WorkspaceStore.WorkspaceStoreError) return `Rika failed: ${error.message}`
  if (error instanceof Execute.ExecuteError) return Execute.formatError(error)
  return error instanceof Error ? `Rika failed: ${error.message}` : `Rika failed: ${String(error)}`
}

const runtimeExitCode = (error: RuntimeError) => {
  if (error instanceof Execute.ExecuteError) return error.exit_code
  if (error instanceof OrbExecute.OrbExecuteError) return error.exit_code
  return 1
}

const tagged = (error: unknown, tag: string): boolean =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === tag

const orbMirrorSyncFailure = (error: OrbMirror.RunError): Diagnostics.Entry => ({
  level: "error",
  message: "orb_mirror.sync error",
  data: {
    op: "orb_mirror.sync",
    outcome: "error",
    error: error instanceof Error ? error.message : String(error),
    error_tag: taggedErrorName(error),
  },
})

const taggedErrorName = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string"
    ? error._tag
    : "unknown"

const telemetryLayers = (env: Record<string, string | undefined>, configLayer: Layer.Layer<Config.Service>) => {
  const options = Telemetry.fromEnv(env, Version.version)
  const diagnosticsLayer = (options.enabled ? Telemetry.diagnosticsLayer(options) : Diagnostics.layer).pipe(
    Layer.provideMerge(configLayer),
  )
  const telemetryLayer = options.enabled ? Telemetry.layer(options) : Layer.empty
  return { diagnosticsLayer, telemetryLayer }
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
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, configLayer)
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(IdGenerator.layer),
  )
  const llmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(Layer.provideMerge(configLayer))
  const pluginLayer = PluginHost.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(PluginUi.silentLayer))
  const permissionConfig = PermissionPolicy.configFromEnv(env)
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    workspaceStoreLayer,
    projectStoreLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const subagentToolLayer = BuiltInTools.subagentToolExecutorLayerFromPermissionConfig(permissionConfig).pipe(
    Layer.provideMerge(configLayer),
  )
  const subagentLayer = SubagentRuntime.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
    Layer.provide(subagentToolLayer),
  )
  const specialtyToolLayer = SpecialtyTools.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
  )
  const toolLayer = BuiltInTools.toolExecutorLayerFromPermissionConfig(permissionConfig).pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(pluginLayer),
    Layer.provideMerge(specialtyToolLayer),
    Layer.provideMerge(subagentLayer),
  )
  const skillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const storageAndThreadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const contextResolverLayer = ContextResolver.layer.pipe(Layer.provide(storageAndThreadLayer))
  const baseLayer = Layer.mergeAll(
    Output.layer,
    Input.layer,
    migratedStorageLayer,
    storageAndThreadLayer,
    workspaceAccessLayer,
    contextResolverLayer,
    skillLayer,
    toolLayer,
    llmLayer,
    diagnosticsLayer,
    telemetryLayer,
  )
  const commandLayer = Execute.layer.pipe(Layer.provideMerge(AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))))

  return commandLayer
}

export const orbExecuteLiveLayer = (
  command: Args.ExecuteCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<OrbExecuteLayerOutput, LiveLayerError, Output.Service> => {
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
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, configLayer)
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
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
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    timeLayer,
    IdGenerator.layer,
    projectStoreLayer,
    orbStoreLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const managerLayer = OrbManager.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const commandLayer = OrbExecute.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(telemetryLayer),
  )

  return commandLayer
}

export const interactiveLiveLayer = (
  command: Args.InteractiveCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<InteractiveLayerOutput, LiveLayerError> =>
  Layer.unwrap(loadTui().pipe(Effect.map((tui) => interactiveLiveLayerFromTui(command, env, cwd, tui))))

const interactiveLiveLayerFromTui = (
  command: Args.InteractiveCommand,
  env: Record<string, string | undefined>,
  cwd: string,
  tui: TuiModule,
): Layer.Layer<InteractiveLayerOutput, LiveLayerError> => {
  const { Adapter, Session, Ticker } = tui
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
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, configLayer)
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const llmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(Layer.provideMerge(configLayer))
  const pluginLayer = PluginHost.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(PluginUi.silentLayer))
  const permissionConfig = PermissionPolicy.configFromEnv(env)
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    workspaceStoreLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const subagentToolLayer = BuiltInTools.subagentToolExecutorLayerFromPermissionConfig(permissionConfig).pipe(
    Layer.provideMerge(configLayer),
  )
  const subagentLayer = SubagentRuntime.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
    Layer.provide(subagentToolLayer),
  )
  const specialtyToolLayer = SpecialtyTools.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
  )
  const toolLayer = BuiltInTools.toolExecutorLayerFromPermissionConfig(permissionConfig).pipe(
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
    Adapter.layer,
    Ticker.layer,
    storageAndThreadLayer,
    contextResolverLayer,
    reviewServiceLayer,
    skillLayer,
    toolLayer,
    llmLayer,
    diagnosticsLayer,
    telemetryLayer,
  )
  const sessionLayer = Session.layer.pipe(Layer.provideMerge(AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))))

  return sessionLayer
}

export const interactiveRemoteLiveLayer = (
  command: Args.InteractiveCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<InteractiveRemoteLayerOutput, LiveLayerError> =>
  Layer.unwrap(loadTui().pipe(Effect.map((tui) => interactiveRemoteLiveLayerFromTui(command, env, cwd, tui))))

const interactiveRemoteLiveLayerFromTui = (
  command: Args.InteractiveCommand,
  env: Record<string, string | undefined>,
  cwd: string,
  tui: TuiModule,
): Layer.Layer<InteractiveRemoteLayerOutput, LiveLayerError> => {
  const { Adapter, RemoteSession, Ticker } = tui
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const mode = command.mode ?? "smart"
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: mode,
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(IdGenerator.layer),
  )
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    Migration.layer,
    timeLayer,
    IdGenerator.layer,
    projectStoreLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const backendLayer = LocalBackend.layerFromInput({ env, cwd })
  const remoteSessionLayer = Layer.effect(
    RemoteSession.Service,
    Effect.gen(function* () {
      const backend = yield* LocalBackend.Service
      const renderer = yield* Adapter.Service
      const ticker = yield* Ticker.Service
      const workspaceId = yield* workspaceIdForRoot(workspaceRoot)
      const client = reconnectingClient({ backend, workspace_root: workspaceRoot, data_dir: dataDir, mode })
      return RemoteSession.make(client, renderer, ticker.ticks, workspaceId)
    }),
  ).pipe(
    Layer.provideMerge(backendLayer),
    Layer.provideMerge(Adapter.layer),
    Layer.provideMerge(Ticker.layer),
    Layer.provideMerge(migratedStorageLayer),
  )

  return remoteSessionLayer
}

const workspaceIdForRoot = Effect.fn("Cli.Runtime.workspaceIdForRoot")(function* (workspaceRoot: string) {
  const projectId = yield* Project.resolveCurrentProjectId(workspaceRoot)
  return WorkspaceIdentity.resolveWorkspaceId({
    workspace_root: workspaceRoot,
    ...(projectId === undefined ? {} : { project_id: projectId }),
  })
})

export interface ReconnectingClientInput {
  readonly backend: LocalBackend.Interface
  readonly workspace_root: string
  readonly data_dir: string
  readonly mode: Config.Mode
  readonly fetch?: Client.FetchTransportInput["fetch"]
}

export const reconnectingClient = (input: ReconnectingClientInput): Client.Interface => {
  let current: LocalBackend.BackendEndpoint | undefined
  const resolveEndpoint = (refresh: boolean) =>
    current !== undefined && !refresh
      ? Effect.succeed(current)
      : input.backend
          .connectOrStart({
            workspace_root: input.workspace_root,
            data_dir: input.data_dir,
            mode: input.mode,
          })
          .pipe(
            Effect.tap((next) =>
              Effect.sync(() => {
                current = next
              }),
            ),
            Effect.mapError(
              (error) =>
                new Client.SdkError({
                  message: error.message,
                  operation: `backend.${error.operation}`,
                }),
            ),
          )
  const clientForEndpoint = (resolvedEndpoint: LocalBackend.BackendEndpoint) =>
    Client.make(
      Client.fetchTransport({
        base_url: resolvedEndpoint.url,
        token: resolvedEndpoint.token,
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      }),
    )
  const request = <A>(use: (remote: Client.Interface) => Effect.Effect<A, Client.SdkError>) =>
    resolveEndpoint(false).pipe(
      Effect.map(clientForEndpoint),
      Effect.flatMap(use),
      Effect.catchTag("SdkError", (error) =>
        retryableSdkError(error)
          ? resolveEndpoint(true).pipe(Effect.map(clientForEndpoint), Effect.flatMap(use))
          : Effect.fail(error),
      ),
    )
  const stream = <A>(use: (remote: Client.Interface) => Stream.Stream<A, Client.SdkError>) =>
    Stream.unwrap(resolveEndpoint(false).pipe(Effect.map((next) => use(clientForEndpoint(next))))).pipe(
      Stream.catch((error: Client.SdkError) =>
        retryableSdkError(error)
          ? Stream.unwrap(resolveEndpoint(true).pipe(Effect.map((next) => use(clientForEndpoint(next)))))
          : Stream.fail(error),
      ),
    )

  return {
    backendHealth: () => request((remote) => remote.backendHealth()),
    createThread: (thread) => request((remote) => remote.createThread(thread)),
    listThreads: (thread) => request((remote) => remote.listThreads(thread)),
    openThread: (threadId, userId) => request((remote) => remote.openThread(threadId, userId)),
    previewThread: (threadId, preview) => request((remote) => remote.previewThread(threadId, preview)),
    archiveThread: (threadId, userId) => request((remote) => remote.archiveThread(threadId, userId)),
    unarchiveThread: (threadId, userId) => request((remote) => remote.unarchiveThread(threadId, userId)),
    searchThreads: (search) => request((remote) => remote.searchThreads(search)),
    shareThread: (threadId, userId) => request((remote) => remote.shareThread(threadId, userId)),
    referenceThread: (reference) => request((remote) => remote.referenceThread(reference)),
    subscribeThreadEvents: (subscription) => stream((remote) => remote.subscribeThreadEvents(subscription)),
    startTurn: (turn) => request((remote) => remote.startTurn(turn)),
    interruptTurn: (turn) => request((remote) => remote.interruptTurn(turn)),
    listArtifacts: (artifacts) => request((remote) => remote.listArtifacts(artifacts)),
    getArtifact: (artifactId, userId) => request((remote) => remote.getArtifact(artifactId, userId)),
    connectIde: (connection) => request((remote) => remote.connectIde(connection)),
    disconnectIde: (disconnection) => request((remote) => remote.disconnectIde(disconnection)),
    updateIdeContext: (context) => request((remote) => remote.updateIdeContext(context)),
    ideStatus: () => request((remote) => remote.ideStatus()),
    openIdeFile: (file) => request((remote) => remote.openIdeFile(file)),
    ideNavigationRequests: () => request((remote) => remote.ideNavigationRequests()),
  }
}

const retryableSdkError = (error: Client.SdkError): boolean => error.status === undefined

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
      default_mode: defaultModeFromEnv(env),
      ...(env.RIKA_BACKEND_ID === undefined ? {} : { backend_id: env.RIKA_BACKEND_ID }),
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
      default_mode: defaultModeFromEnv(env),
      ...(env.RIKA_BACKEND_ID === undefined ? {} : { backend_id: env.RIKA_BACKEND_ID }),
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

export const projectLiveLayer = (
  _command: Args.ProjectCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<ProjectLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: defaultModeFromEnv(env),
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const projectStoreLayer = ProjectStore.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(IdGenerator.layer),
  )
  const storageLayer = Layer.mergeAll(
    configLayer,
    Output.layer,
    Input.layer,
    databaseLayer,
    Migration.layer,
    timeLayer,
    IdGenerator.layer,
    projectStoreLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const commandLayer = Project.layer.pipe(Layer.provideMerge(migratedStorageLayer))

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
      default_mode: defaultModeFromEnv(env),
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
      default_mode: defaultModeFromEnv(env),
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
  const llmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(Layer.provideMerge(configLayer))
  const subagentToolLayer = BuiltInTools.subagentToolExecutorLayerFromPermissionConfig(
    PermissionPolicy.configFromEnv(env),
  ).pipe(Layer.provideMerge(configLayer))
  const subagentLayer = SubagentRuntime.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
    Layer.provide(subagentToolLayer),
  )
  const reviewServiceLayer = ReviewService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(CheckRegistry.layer.pipe(Layer.provideMerge(configLayer))),
    Layer.provideMerge(subagentLayer),
  )
  const commandLayer = Review.layer.pipe(Layer.provideMerge(Output.layer), Layer.provideMerge(reviewServiceLayer))

  return commandLayer
}

export const extensionsLiveLayer = (
  _command: Args.ExtensionCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<ExtensionsLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: defaultModeFromEnv(env),
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
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
  const selfExtensionLayer = SelfExtension.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const commandLayer = Extensions.layer.pipe(Layer.provideMerge(Output.layer), Layer.provideMerge(selfExtensionLayer))

  return commandLayer
}

export const ideLiveLayer = (
  _command: Args.IdeCommand,
  _env: Record<string, string | undefined>,
  _cwd: string,
): Layer.Layer<IdeLayerOutput, LiveLayerError> => Ide.layer.pipe(Layer.provideMerge(Output.layer))

export const doctorLiveLayer = (
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<DoctorLayerOutput, LiveLayerError> =>
  Doctor.layerFromInput({ env, cwd }).pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(LocalBackend.layerFromInput({ env, cwd })),
  )

export const serverLiveLayer = (
  command: Args.ServerCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<ServerLayerOutput, LiveLayerError> => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = Config.layerFromValues(
    {
      workspace_root: workspaceRoot,
      data_dir: dataDir,
      default_mode: defaultModeFromEnv(env),
      ...(env.RIKA_BACKEND_ID === undefined ? {} : { backend_id: env.RIKA_BACKEND_ID }),
      ...(env.RIKA_DATABASE_URL === undefined ? {} : { database_url: env.RIKA_DATABASE_URL }),
    },
    env,
  )
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, configLayer)
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const orbStoreLayer = OrbStore.layer.pipe(
    Layer.provideMerge(databaseLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(IdGenerator.layer),
  )
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const llmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(Layer.provideMerge(configLayer))
  const pluginLayer = PluginHost.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(PluginUi.silentLayer))
  const permissionConfig = PermissionPolicy.configFromEnv(env)
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    workspaceStoreLayer,
    orbStoreLayer,
    Migration.layer,
    ThreadEventLog.layer,
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const subagentToolLayer = BuiltInTools.subagentToolExecutorLayerFromPermissionConfig(permissionConfig).pipe(
    Layer.provideMerge(configLayer),
  )
  const subagentLayer = SubagentRuntime.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
    Layer.provide(subagentToolLayer),
  )
  const specialtyToolLayer = SpecialtyTools.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
  )
  const toolLayer = BuiltInTools.toolExecutorLayerFromPermissionConfig(permissionConfig).pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(pluginLayer),
    Layer.provideMerge(specialtyToolLayer),
    Layer.provideMerge(subagentLayer),
  )
  const skillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const storageAndThreadLayer = ThreadService.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const contextResolverLayer = ContextResolver.layer.pipe(Layer.provide(storageAndThreadLayer))
  const baseLayer = Layer.mergeAll(
    Output.layer,
    migratedStorageLayer,
    storageAndThreadLayer,
    workspaceAccessLayer,
    contextResolverLayer,
    skillLayer,
    toolLayer,
    llmLayer,
    artifactLayer,
    IdeBridge.layer,
    diagnosticsLayer,
    telemetryLayer,
  )
  const threadLiveLayer = ThreadLive.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const agentLayer = AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))
  const remoteLayer = RemoteControl.layerWithLive.pipe(
    Layer.provideMerge(agentLayer),
    Layer.provideMerge(baseLayer),
    Layer.provideMerge(threadLiveLayer),
  )
  const orbMirrorLayer = OrbMirror.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(threadLiveLayer),
    Layer.provideMerge(sandboxLayer),
  )
  const orbMirrorStartupLayer = Layer.effectDiscard(
    Effect.repeat(
      OrbMirror.syncRunning().pipe(Effect.catch((error) => Diagnostics.emit(orbMirrorSyncFailure(error)))),
      Schedule.spaced("5 seconds"),
    ).pipe(Effect.forkScoped),
  ).pipe(Layer.provideMerge(orbMirrorLayer), Layer.provide(diagnosticsLayer))
  const httpLayer = HttpServer.layer.pipe(Layer.provideMerge(remoteLayer))
  const commandLayer = Layer.mergeAll(
    Server.layer.pipe(Layer.provideMerge(Output.layer), Layer.provideMerge(httpLayer)),
    orbMirrorStartupLayer,
  )

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
  | ProjectStore.Service
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

export type OrbExecuteLayerOutput =
  | Config.Service
  | Database.Service
  | IdGenerator.Service
  | Migration.Service
  | OrbExecute.Service
  | OrbManager.Service
  | OrbStore.Service
  | ProjectStore.Service
  | SandboxClient.Service
  | Time.Service

export type InteractiveLayerOutput =
  | Adapter.Service
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
  | ReviewService.Service
  | Router.Service
  | Session.Service
  | SkillRegistry.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | Ticker.Service
  | ThreadEventLog.Service
  | ThreadProjection.Service
  | ThreadService.Service
  | Time.Service
  | ToolExecutor.Service
  | WorkspaceStore.Service

export type InteractiveRemoteLayerOutput =
  | Adapter.Service
  | Config.Service
  | Database.Service
  | IdGenerator.Service
  | LocalBackend.Service
  | Migration.Service
  | ProjectStore.Service
  | RemoteSession.Service
  | Ticker.Service
  | Time.Service

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

export type ProjectLayerOutput =
  | Config.Service
  | Database.Service
  | IdGenerator.Service
  | Input.Service
  | Migration.Service
  | Output.Service
  | Project.Service
  | ProjectStore.Service
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
  | Review.Service
  | ReviewService.Service
  | Router.Service
  | SubagentRuntime.Service
  | Time.Service

export type ExtensionsLayerOutput =
  | ArtifactStore.Service
  | Config.Service
  | Database.Service
  | Extensions.Service
  | IdGenerator.Service
  | Migration.Service
  | Output.Service
  | SelfExtension.Service
  | Time.Service

export type IdeLayerOutput = Output.Service | Ide.Service

export type DoctorLayerOutput = Doctor.Service | LocalBackend.Service | Output.Service

export type ServerLayerOutput =
  | AgentLoop.Service
  | ArtifactStore.Service
  | Config.Service
  | ContextResolver.Service
  | Database.Service
  | HttpServer.Service
  | IdeBridge.Service
  | IdGenerator.Service
  | McpApprovalStore.Service
  | Migration.Service
  | Output.Service
  | PluginHost.Service
  | RemoteControl.Service
  | Router.Service
  | OrbMirror.Service
  | OrbStore.Service
  | SandboxClient.Service
  | Server.Service
  | SkillRegistry.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | ThreadEventLog.Service
  | ThreadLive.Service
  | ThreadProjection.Service
  | ThreadService.Service
  | Time.Service
  | ToolExecutor.Service
  | WorkspaceAccess.Service
  | WorkspaceStore.Service

export type LiveLayerError =
  | Config.ConfigError
  | ContextResolver.ContextResolverError
  | Client.SdkError
  | Database.DatabaseError
  | FffSearch.FffSearchError
  | IdeBridge.IdeBridgeError
  | LocalBackend.BackendError
  | McpApprovalStore.McpApprovalStoreError
  | McpClient.RunError
  | Migration.MigrationError
  | OrbMirror.OrbMirrorError
  | OrbStore.OrbStoreError
  | PluginHost.RunError
  | ProjectStore.ProjectStoreError
  | ReviewService.RunError
  | SandboxClient.OrbConfigError

const defaultModeFromEnv = (env: Record<string, string | undefined>): Config.Mode => {
  const value = env.RIKA_MODE
  if (value === "rush" || value === "smart" || value === "deep1" || value === "deep2" || value === "deep3") return value
  return "smart"
}
