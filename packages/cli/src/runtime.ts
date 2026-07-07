import {
  AgentLoop,
  CheckRegistry,
  CompactionService,
  ContextResolver,
  JudgeService,
  PermissionPolicy,
  ReviewService,
  SkillRegistry,
  SkillToolProvider,
  SubagentRuntime,
  ThreadMemory,
  ThreadMemoryIndexer,
  ThreadService,
  ToolExecutor,
  TournamentService,
  WorkspaceAccess,
  WorkspaceIdentity,
} from "@rika/agent"
import { Config, Diagnostics, IdGenerator, SecretRedactor, Settings, Telemetry, Time } from "@rika/core"
import { IdeBridge } from "@rika/ide"
import { Embeddings, Live, Router } from "@rika/llm"
import { OrbActivity, OrbManager, SandboxClient } from "@rika/orb"
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
import { PluginHost, PluginUi, SelfExtension } from "@rika/plugin"
import { Client } from "@rika/sdk"
import { Ids, Remote } from "@rika/schema"
import { HttpServer, OrbMirror, PresenceHub, RemoteControl, ThreadLive } from "@rika/server"
import { BaseServiceLayer, BuiltInTools, FffSearch, McpClient, SpecialtyTools } from "@rika/tools"
import type { Adapter, RemoteSession, Session, Ticker } from "@rika/tui"
import { Effect, Layer, Schedule, Stream } from "effect"
import * as Args from "./args"
import * as BackendEndpoint from "./backend-endpoint"
import * as CliConfig from "./config"
import * as Doctor from "./doctor"
import * as Execute from "./execute"
import * as Extensions from "./extensions"
import * as Help from "./help"
import * as Ide from "./ide"
import * as Input from "./input"
import * as LocalBackend from "./local-backend"
import * as Mcp from "./mcp"
import * as Memory from "./memory"
import * as Orb from "./orb"
import * as OrbExecute from "./orb-execute"
import * as OrbShell from "./orb-shell"
import * as OrbTournament from "./orb-tournament"
import * as Output from "./output"
import * as Project from "./project"
import * as Review from "./review"
import * as RuntimeEnv from "./runtime-env"
import * as Server from "./server"
import * as SkillInstaller from "./skill-installer"
import * as Skills from "./skills"
import * as Sync from "./sync"
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
              validateRuntimeEnv(command, env, input.cwd).pipe(
                Effect.flatMap(() =>
                  command.type === "invalid_execute_alias"
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
                                      ? CliConfig.executeCommand(command).pipe(
                                          Effect.provide(configLiveLayer(env, input.cwd)),
                                        )
                                      : command.type === "orb"
                                        ? Orb.executeCommand(command).pipe(
                                            Effect.provide(orbLiveLayer(command, env, input.cwd)),
                                          )
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
                                                : command.type === "sync"
                                                  ? Sync.executeCommand(command).pipe(
                                                      Effect.provide(syncLiveLayer(command, env, input.cwd)),
                                                    )
                                                  : command.type === "memory"
                                                    ? Memory.executeCommand(command).pipe(
                                                        Effect.provide(memoryLiveLayer(command, env, input.cwd)),
                                                      )
                                                    : Server.executeCommand(command).pipe(
                                                        Effect.provide(serverLiveLayer(command, env, input.cwd)),
                                                      ),
                ),
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
  | BackendEndpoint.BackendEndpointError
  | CheckRegistry.CheckRegistryError
  | ContextResolver.ContextResolverError
  | Config.ConfigError
  | Database.DatabaseError
  | Doctor.DoctorError
  | Execute.ExecuteError
  | Embeddings.EmbeddingsProviderError
  | Embeddings.EmbeddingsValidationError
  | Extensions.ExtensionsError
  | FffSearch.FffSearchError
  | Client.SdkError
  | CliConfig.ConfigCommandError
  | Ide.IdeError
  | IdeBridge.IdeBridgeError
  | Input.InputError
  | LocalBackend.BackendError
  | Mcp.McpError
  | Memory.RunError
  | McpApprovalStore.McpApprovalStoreError
  | McpClient.McpClientError
  | Migration.MigrationError
  | OrbActivity.OrbActivityError
  | OrbManager.OrbProvisionError
  | OrbMirror.OrbMirrorError
  | Orb.OrbError
  | OrbExecute.OrbExecuteError
  | OrbShell.OrbShellError
  | OrbTournament.OrbTournamentError
  | OrbStore.OrbStoreError
  | PluginHost.RunError
  | Project.ProjectError
  | ProjectStore.ProjectStoreError
  | Review.ReviewError
  | ReviewService.ReviewServiceError
  | TournamentService.RunError
  | RemoteControl.RemoteControlError
  | RemoteSession.RemoteSessionError
  | Server.ServerError
  | SandboxClient.SandboxClientError
  | SandboxClient.OrbConfigError
  | Settings.SettingsError
  | HttpServer.HttpServerError
  | Session.SessionError
  | SelfExtension.SelfExtensionError
  | SkillInstaller.SkillInstallerError
  | SkillRegistry.SkillRegistryError
  | SubagentRuntime.RunError
  | Skills.SkillsError
  | Sync.SyncError
  | ThreadService.ThreadForkError
  | ThreadService.ThreadServiceError
  | ThreadEventLog.ThreadEventLogError
  | ThreadMemoryIndexer.ThreadMemoryIndexerError
  | ThreadMemoryStore.ThreadMemoryStoreError
  | ThreadProjection.ThreadProjectionError
  | Threads.ThreadsError
  | WorkspaceAccess.RunError
  | WorkspaceStore.WorkspaceStoreError

const formatRuntimeError = (error: RuntimeError) => {
  if (error instanceof Migration.MigrationError) return `Rika failed: ${error.message}`
  if (error instanceof BackendEndpoint.BackendEndpointError) return `Rika failed: ${error.message}`
  if (error instanceof Extensions.ExtensionsError) return Extensions.formatError(error)
  if (error instanceof FffSearch.FffSearchError) return `Rika failed: ${error.message}`
  if (error instanceof Client.SdkError) return `Rika failed: ${error.message}`
  if (error instanceof CliConfig.ConfigCommandError) return CliConfig.formatError(error)
  if (error instanceof Ide.IdeError) return Ide.formatError(error)
  if (error instanceof IdeBridge.IdeBridgeError) return `Rika failed: ${error.message}`
  if (error instanceof Input.InputError) return `Rika failed: ${error.message}`
  if (error instanceof LocalBackend.BackendError) return `Rika failed: ${error.message}`
  if (error instanceof Mcp.McpError) return Mcp.formatError(error)
  if (
    error instanceof ThreadMemoryIndexer.ThreadMemoryIndexerError ||
    error instanceof ThreadMemoryStore.ThreadMemoryStoreError ||
    error instanceof Embeddings.EmbeddingsProviderError ||
    error instanceof Embeddings.EmbeddingsValidationError
  ) {
    return Memory.formatError(error)
  }
  if (error instanceof McpApprovalStore.McpApprovalStoreError) return `Rika failed: ${error.message}`
  if (error instanceof McpClient.McpClientError) return `Rika failed: ${error.message}`
  if (error instanceof OrbActivity.OrbActivityError) return `Rika failed: ${error.message}`
  if (error instanceof OrbMirror.OrbMirrorError) return `Rika failed: ${error.message}`
  if (error instanceof Orb.OrbError) return Orb.formatError(error)
  if (error instanceof OrbExecute.OrbExecuteError) return OrbExecute.formatError(error)
  if (error instanceof OrbShell.OrbShellError) return `Rika failed: ${error.message}`
  if (error instanceof OrbTournament.OrbTournamentError) return OrbTournament.formatError(error)
  if (error instanceof OrbManager.OrbProvisionError) return `Rika failed: ${error.message}`
  if (error instanceof OrbStore.OrbStoreError) return `Rika failed: ${error.message}`
  if (error instanceof Review.ReviewError) return Review.formatError(error)
  if (error instanceof ReviewService.ReviewServiceError) return `Rika failed: ${error.message}`
  if (error instanceof TournamentService.TournamentError) return `Rika failed: ${error.message}`
  if (error instanceof TournamentService.TournamentTurnError) return `Rika failed: ${error.message}`
  if (error instanceof RemoteControl.RemoteControlError) return `Rika failed: ${error.message}`
  if (error instanceof Server.ServerError) return Server.formatError(error)
  if (error instanceof SandboxClient.SandboxClientError) return `Rika failed: ${error.message}`
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
  if (error instanceof Settings.SettingsError) return `Rika failed: ${error.message}`
  if (error instanceof Database.DatabaseError) return `Rika failed: ${error.message}`
  if (error instanceof Doctor.DoctorError) return Doctor.formatError(error)
  if (tagged(error, "RemoteSessionError")) return `Rika failed: ${error.message}`
  if (tagged(error, "SessionError")) return `Rika failed: ${error.message}`
  if (error instanceof SelfExtension.SelfExtensionError) return `Rika failed: ${error.message}`
  if (error instanceof SkillInstaller.SkillInstallerError) return error.message
  if (error instanceof SkillRegistry.SkillRegistryError) return `Rika failed: ${error.message}`
  if (error instanceof SkillToolProvider.SkillToolProviderError) return `Rika failed: ${error.message}`
  if (error instanceof Skills.SkillsError) return Skills.formatError(error)
  if (error instanceof Sync.SyncError) return Sync.formatError(error)
  if (error instanceof ThreadService.ThreadForkError) return `Rika failed: ${error.message}`
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
  if (error instanceof Orb.OrbError) return error.exit_code
  if (error instanceof OrbExecute.OrbExecuteError) return error.exit_code
  if (error instanceof OrbShell.OrbShellError) return error.exit_code
  if (error instanceof SkillInstaller.SkillInstallerError) return error.exit_code
  if (error instanceof Sync.SyncError) return error.exit_code
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

export const secretRedactorLayer = (
  env: Record<string, string | undefined>,
  entries: ReadonlyArray<SecretRedactor.Entry> = [],
) => SecretRedactor.layerFromEntries([...SecretRedactor.entriesFromEnv(env), ...entries])

const telemetryLayers = (
  env: Record<string, string | undefined>,
  workspaceRoot: string,
  configLayer: Layer.Layer<Config.Service, Config.ConfigError>,
  redactorLayer: Layer.Layer<SecretRedactor.Service> = secretRedactorLayer(env),
) => {
  const options = Settings.loadSnapshotFromEnv(env, workspaceRoot).pipe(
    Effect.map((snapshot) => Telemetry.fromSettingsSnapshot(snapshot, Version.version)),
  )
  const diagnosticsLayer = Layer.unwrap(
    options.pipe(
      Effect.map((resolved) =>
        (resolved.enabled ? Telemetry.diagnosticsLayer(resolved) : Diagnostics.layer).pipe(
          Layer.provideMerge(configLayer),
          Layer.provideMerge(redactorLayer),
        ),
      ),
    ),
  )
  const telemetryLayer = Layer.unwrap(
    options.pipe(Effect.map((resolved) => (resolved.enabled ? Telemetry.layer(resolved) : Layer.empty))),
  )
  return { diagnosticsLayer, telemetryLayer }
}

const runtimeConfigLayer = (
  env: Record<string, string | undefined>,
  workspaceRoot: string,
  modeOverride?: Config.Mode,
): Layer.Layer<Config.Service, Config.ConfigError> => {
  const configEnv = {
    ...env,
    RIKA_WORKSPACE_ROOT: workspaceRoot,
    ...(modeOverride === undefined ? {} : { RIKA_MODE: modeOverride }),
  }
  return Config.layerFromEnv(configEnv, workspaceRoot)
}

const validateRuntimeEnv = (
  command: Args.Command,
  env: Record<string, string | undefined>,
  cwd: string,
): Effect.Effect<void, RuntimeError> => {
  if (command.type === "invalid_execute_alias" || command.type === "help" || command.type === "version") {
    return Effect.void
  }
  const workspaceRoot = commandWorkspaceRoot(command, env, cwd)
  const modeOverride = "mode" in command ? command.mode : undefined
  const configEnv = {
    ...env,
    RIKA_WORKSPACE_ROOT: workspaceRoot,
    ...(modeOverride === undefined ? {} : { RIKA_MODE: modeOverride }),
  }
  return BaseServiceLayer.validateRuntimeEnv({ env: configEnv, workspaceRoot })
}

const commandWorkspaceRoot = (command: Args.Command, env: Record<string, string | undefined>, cwd: string) => {
  const workspaceRoot = "workspace_root" in command ? command.workspace_root : undefined
  return workspaceRoot ?? env.RIKA_WORKSPACE_ROOT ?? cwd
}

export const liveLayer = (
  command: Args.ExecuteCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<LiveLayerOutput, LiveLayerError> => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot, command.mode)
  const redactorLayer = secretRedactorLayer(env)
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer, redactorLayer)
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const permissionConfig = PermissionPolicy.configFromEnv(env)
  const serviceLayers = BaseServiceLayer.fromEnvWithOrbStoreAndMemoryIndexer({
    env,
    workspaceRoot,
    configLayer,
    redactorLayer,
    diagnosticsLayer,
    databaseMode: command.ephemeral ? "memory" : "live",
    permissionConfig,
  })
  const baseLayer = Layer.mergeAll(Output.layer, Input.layer, serviceLayers.baseLayer, telemetryLayer)
  const managerLayer = OrbManager.layer.pipe(
    Layer.provideMerge(serviceLayers.migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const backendEndpointResolverLayer = BackendEndpoint.resolverLayerFromEnv(env).pipe(
    Layer.provideMerge(LocalBackend.layerFromInput({ env, cwd })),
    Layer.provideMerge(BackendEndpoint.healthLayer),
    Layer.provideMerge(serviceLayers.migratedStorageLayer),
    Layer.provideMerge(BackendEndpoint.orbManagerResumerLayer),
    Layer.provideMerge(managerLayer),
  )
  const agentLoopLayer = AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))

  const commandLayer = command.ephemeral
    ? Execute.layer.pipe(Layer.provideMerge(agentLoopLayer), Layer.provideMerge(backendEndpointResolverLayer))
    : Execute.layerWithClientFactory().pipe(
        Layer.provideMerge(baseLayer),
        Layer.provideMerge(backendEndpointResolverLayer),
        Layer.provideMerge(agentLoopLayer),
      )

  return commandLayer
}

export const orbExecuteLiveLayer = (
  command: Args.ExecuteCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<OrbExecuteLayerOutput, LiveLayerError, Output.Service> => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot, command.mode)
  const redactorLayer = secretRedactorLayer(env)
  const settingsLayer = Settings.layerFromEnv(env, workspaceRoot)
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer, redactorLayer)
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
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
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    redactorLayer,
    settingsLayer,
    mcpApprovalLayer,
    Migration.layer,
    timeLayer,
    IdGenerator.layer,
    projectStoreLayer,
    orbStoreLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(
    Migration.migrate().pipe(Effect.andThen(OrbStore.repairUsageIntervals())),
  ).pipe(Layer.provideMerge(storageLayer))
  const managerLayer = OrbManager.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const commandLayer = OrbExecute.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(telemetryLayer),
    Layer.provideMerge(settingsLayer),
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
  const configLayer = runtimeConfigLayer(env, workspaceRoot, command.mode)
  const redactorLayer = secretRedactorLayer(env)
  const settingsLayer = Settings.layerFromEnv(env, workspaceRoot)
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer, redactorLayer)
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const memoryStoreLayer = ThreadMemoryStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const llmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const permissionConfig = PermissionPolicy.configFromEnv(env)
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    workspaceStoreLayer,
    memoryStoreLayer,
    Migration.layer,
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const pluginLayer = PluginHost.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(PluginUi.silentLayer),
    Layer.provideMerge(migratedStorageLayer),
  )
  const embeddingsLayer = Embeddings.layer(
    Embeddings.optionsFromEnv(env, { openaiConfigured: Live.optionsFromEnv(env).openai !== undefined }),
  )
  const memoryIndexerLayer = ThreadMemoryIndexer.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const storageAndThreadLayer = ThreadService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const threadMemoryLayer = ThreadMemory.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(storageAndThreadLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(timeLayer),
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
  const skillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const checkLayer = CheckRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const reviewServiceLayer = ReviewService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(checkLayer),
    Layer.provideMerge(subagentLayer),
  )
  const contextResolverLayer = ContextResolver.layer.pipe(
    Layer.provide(storageAndThreadLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(settingsLayer),
  )
  const threadLiveLayer = ThreadLive.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const baseLayer = Layer.mergeAll(
    Adapter.layer,
    Ticker.layer,
    storageAndThreadLayer,
    contextResolverLayer,
    reviewServiceLayer,
    skillLayer,
    skillToolProviderLayer,
    memoryIndexerLayer,
    toolLayer,
    llmLayer,
    diagnosticsLayer,
    telemetryLayer,
  )
  const agentLoopLayer = AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))
  const judgeLayer = JudgeService.layer.pipe(Layer.provideMerge(migratedStorageLayer), Layer.provideMerge(llmLayer))
  const tournamentLayer = TournamentService.layer.pipe(
    Layer.provideMerge(storageAndThreadLayer),
    Layer.provideMerge(judgeLayer),
    Layer.provideMerge(localTournamentTurnControlLayer.pipe(Layer.provideMerge(threadLiveLayer))),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(agentLoopLayer),
  )
  const sessionLayer = Session.layer.pipe(Layer.provideMerge(agentLoopLayer), Layer.provideMerge(tournamentLayer))

  return sessionLayer.pipe(Layer.provideMerge(settingsLayer))
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
  const { Adapter, Keymap, RemoteSession, Ticker } = tui
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const mode = command.mode
  const configLayer = runtimeConfigLayer(env, workspaceRoot, mode)
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const redactorLayer = secretRedactorLayer(env)
  const settingsLayer = Settings.layerFromEnv(env, workspaceRoot)
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer, redactorLayer)
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
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
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    redactorLayer,
    settingsLayer,
    Migration.layer,
    timeLayer,
    IdGenerator.layer,
    projectStoreLayer,
    orbStoreLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(
    Migration.migrate().pipe(Effect.andThen(OrbStore.repairUsageIntervals())),
  ).pipe(Layer.provideMerge(storageLayer))
  const llmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const activityLayer = OrbActivity.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(timeLayer),
  )
  const managerLayer = OrbManager.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(activityLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const backendLayer = LocalBackend.layerFromInput({ env, cwd })
  const remoteSessionLayer = Layer.effect(
    RemoteSession.Service,
    Effect.gen(function* () {
      const backend = yield* LocalBackend.Service
      const orbs = yield* OrbStore.Service
      const activity = yield* OrbActivity.Service
      const health = yield* BackendEndpoint.Health
      const resumer = yield* BackendEndpoint.OrbResumer
      const renderer = yield* Adapter.Service
      const ticker = yield* Ticker.Service
      const artifactStore = yield* ArtifactStore.Service
      const idGenerator = yield* IdGenerator.Service
      const time = yield* Time.Service
      const settings = yield* Settings.Service
      const snapshot = yield* settings.snapshot
      const keymap = Keymap.effectiveKeymap({ entries: snapshot.values.keymap, sources: snapshot.keymapSources })
      const workspaceId = yield* workspaceIdForRoot(workspaceRoot)
      const resolveEndpoint = (endpointInput: ReconnectingEndpointInput) =>
        BackendEndpoint.resolveEndpoint({
          ...endpointInput,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          ...(mode === undefined ? {} : { mode }),
          env,
        }).pipe(
          Effect.provideService(LocalBackend.Service, backend),
          Effect.provideService(OrbStore.Service, orbs),
          Effect.provideService(BackendEndpoint.Health, health),
          Effect.provideService(BackendEndpoint.OrbResumer, resumer),
        )
      const userId = Ids.UserId.make(snapshot.values.user.name)
      const client = reconnectingClient({
        resolveEndpoint,
        user_id: userId,
        touchOrb: (orbId) => activity.touch(orbId),
      })
      const runTournament = (input: {
        readonly thread_id: Ids.ThreadId
        readonly message: string
        readonly branch_count: number
      }) =>
        TournamentService.run(input).pipe(
          Effect.provide(
            remoteTournamentLayerFromClient(client, configLayer, llmLayer, artifactStore, idGenerator, time),
          ),
          Effect.mapError((error) => tournamentRuntimeError(input.thread_id, error)),
        )
      return RemoteSession.make(client, renderer, ticker.ticks, workspaceId, runTournament, keymap, userId)
    }),
  ).pipe(
    Layer.provideMerge(backendLayer),
    Layer.provideMerge(BackendEndpoint.healthLayer),
    Layer.provideMerge(Adapter.layer),
    Layer.provideMerge(Ticker.layer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(activityLayer),
    Layer.provideMerge(BackendEndpoint.orbManagerResumerLayer),
    Layer.provideMerge(managerLayer),
  )

  return remoteSessionLayer.pipe(Layer.provideMerge(telemetryLayer))
}

const localTournamentTurnControlLayer = Layer.effect(
  TournamentService.TurnControlService,
  Effect.gen(function* () {
    const agentLoop = yield* AgentLoop.Service
    const threads = yield* ThreadService.Service
    const live = yield* ThreadLive.Service
    return TournamentService.TurnControlService.of({
      startTurn: (input) =>
        Effect.gen(function* () {
          const record = yield* threads.open({ thread_id: input.thread_id })
          yield* agentLoop
            .streamTurn({
              thread_id: input.thread_id,
              workspace_id: input.workspace_id ?? record.summary.workspace_id,
              content: input.content,
              ...(input.content_parts === undefined ? {} : { content_parts: input.content_parts }),
              ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
              ...(input.mode === undefined ? {} : { mode: input.mode }),
              ...(input.fast_mode === undefined ? {} : { fast_mode: input.fast_mode }),
              ...(input.cancelled === undefined ? {} : { cancelled: input.cancelled }),
              ...(input.ide_context === undefined ? {} : { ide_context: input.ide_context }),
              ...(input.tool_access === undefined ? {} : { tool_access: input.tool_access }),
            })
            .pipe(
              Stream.runForEach((event) => live.publish(event)),
              Effect.catch(() => Effect.void),
              Effect.forkDetach,
            )
          return { thread_id: input.thread_id, accepted: true as const }
        }).pipe(Effect.mapError((error) => tournamentTurnError("startTurn", input.thread_id, error))),
      subscribeThreadEvents: (input) =>
        live
          .subscribe({
            thread_id: input.thread_id,
            ...(input.after_sequence === undefined ? {} : { after_sequence: input.after_sequence }),
          })
          .pipe(Stream.mapError((error) => tournamentTurnError("subscribeThreadEvents", input.thread_id, error))),
    })
  }),
)

const remoteTournamentLayerFromClient = (
  client: Client.Interface,
  configLayer: Layer.Layer<Config.Service, Config.ConfigError>,
  llmLayer: Layer.Layer<Router.Service, LiveLayerError>,
  artifactStore: ArtifactStore.Interface,
  idGenerator: IdGenerator.Interface,
  time: Time.Interface,
) => {
  const judgeBaseLayer = Layer.mergeAll(
    Layer.succeed(ArtifactStore.Service, ArtifactStore.Service.of(artifactStore)),
    Layer.succeed(IdGenerator.Service, IdGenerator.Service.of(idGenerator)),
    Layer.succeed(Time.Service, Time.Service.of(time)),
  )
  const judgeLayer = JudgeService.layer.pipe(Layer.provideMerge(judgeBaseLayer), Layer.provideMerge(llmLayer))
  return TournamentService.layer.pipe(
    Layer.provideMerge(remoteThreadServiceLayerFromClient(client)),
    Layer.provideMerge(judgeLayer),
    Layer.provideMerge(remoteTournamentTurnControlLayerFromClient(client)),
    Layer.provideMerge(configLayer),
  )
}

const remoteThreadServiceLayerFromClient = (client: Client.Interface) =>
  ThreadService.fakeLayer({
    open: (input) =>
      client.openThread(input.thread_id).pipe(
        Effect.map((record) => ({ summary: remoteThreadSummary(record.summary), events: record.events })),
        Effect.mapError((error) => threadServiceError("open", input.thread_id, error)),
      ),
    fork: (input) =>
      client
        .forkThread(input.thread_id, {
          ...(input.at_turn === undefined ? {} : { at_turn: input.at_turn }),
          ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
          ...(input.title_text === undefined ? {} : { title_text: input.title_text }),
        })
        .pipe(
          Effect.map(remoteThreadSummary),
          Effect.mapError((error) => threadServiceError("fork", input.thread_id, error)),
        ),
  })

const remoteTournamentTurnControlLayerFromClient = (client: Client.Interface) =>
  TournamentService.turnControlLayer({
    startTurn: (input) =>
      client
        .startTurn(input)
        .pipe(Effect.mapError((error) => tournamentTurnError("startTurn", input.thread_id, error))),
    subscribeThreadEvents: (input) =>
      client
        .subscribeThreadEvents(input)
        .pipe(Stream.mapError((error) => tournamentTurnError("subscribeThreadEvents", input.thread_id, error))),
  })

const remoteThreadSummary = (summary: Remote.ThreadSummary): ThreadService.ThreadSummary => ({
  thread_id: summary.thread_id,
  workspace_id: summary.workspace_id,
  ...(summary.user_id === undefined ? {} : { user_id: summary.user_id }),
  ...(summary.title_text === undefined ? {} : { title_text: summary.title_text }),
  ...(summary.latest_message_text === undefined ? {} : { latest_message_text: summary.latest_message_text }),
  diff: summary.diff,
  ...(summary.active_turn_id === undefined ? {} : { active_turn_id: summary.active_turn_id }),
  ...(summary.active_turn_status === undefined ? {} : { active_turn_status: summary.active_turn_status }),
  ...(summary.context_tokens === undefined ? {} : { context_tokens: summary.context_tokens }),
  ...(summary.context_window === undefined ? {} : { context_window: summary.context_window }),
  archived: summary.archived,
  visibility: summary.visibility,
  created_at: summary.created_at,
  updated_at: summary.updated_at,
})

const tournamentTurnError = (operation: string, threadId: Ids.ThreadId, error: unknown) =>
  new TournamentService.TournamentTurnError({
    message: error instanceof Error ? error.message : String(error),
    operation,
    thread_id: threadId,
    cause: error,
  })

const tournamentRuntimeError = (threadId: Ids.ThreadId, error: unknown): TournamentService.RunError => {
  if (
    error instanceof TournamentService.TournamentError ||
    error instanceof TournamentService.TournamentTurnError ||
    error instanceof ThreadService.ThreadServiceError ||
    error instanceof ThreadService.ThreadForkError ||
    error instanceof JudgeService.JudgeError
  ) {
    return error
  }
  return tournamentTurnError("runTournament", threadId, error)
}

const threadServiceError = (operation: string, threadId: Ids.ThreadId, error: unknown) =>
  new ThreadService.ThreadServiceError({
    message: error instanceof Error ? error.message : String(error),
    operation,
    thread_id: threadId,
  })

const workspaceIdForRoot = Effect.fn("Cli.Runtime.workspaceIdForRoot")(function* (workspaceRoot: string) {
  const projectId = yield* Project.resolveCurrentProjectId(workspaceRoot)
  return WorkspaceIdentity.resolveWorkspaceId({
    workspace_root: workspaceRoot,
    ...(projectId === undefined ? {} : { project_id: projectId }),
  })
})

export interface ReconnectingClientInput {
  readonly resolveEndpoint: (
    input: ReconnectingEndpointInput,
  ) => Effect.Effect<BackendEndpoint.BackendEndpoint, ReconnectingResolveError>
  readonly user_id?: Ids.UserId
  readonly touchOrb?: (orbId: Ids.OrbId) => Effect.Effect<void, OrbActivity.RunError>
  readonly fetch?: Client.FetchTransportInput["fetch"]
}

export type ReconnectingResolveError =
  | BackendEndpoint.ResolveError
  | Migration.MigrationError
  | SandboxClient.OrbConfigError

export interface ReconnectingEndpointInput {
  readonly thread_id?: Ids.ThreadId
}

const endpointInputFor = (threadId: Ids.ThreadId | undefined): ReconnectingEndpointInput =>
  threadId === undefined ? {} : { thread_id: threadId }

const cacheKey = (endpointInput: ReconnectingEndpointInput) => endpointInput.thread_id ?? "default"

export const reconnectingClient = (input: ReconnectingClientInput): Client.Interface => {
  const current = new Map<string, BackendEndpoint.BackendEndpoint>()
  const resolveEndpoint = (endpointInput: ReconnectingEndpointInput, refresh: boolean) => {
    const key = cacheKey(endpointInput)
    const cached = current.get(key)
    return cached !== undefined && !refresh
      ? Effect.succeed(cached)
      : input.resolveEndpoint(endpointInput).pipe(
          Effect.tap((next) =>
            Effect.sync(() => {
              current.set(key, next)
            }),
          ),
          Effect.mapError(
            (error) =>
              new Client.SdkError({
                message: error.message,
                operation: resolveErrorOperation(error),
              }),
          ),
        )
  }
  const clientForEndpoint = (resolvedEndpoint: BackendEndpoint.BackendEndpoint) =>
    Client.make(
      Client.fetchTransport({
        base_url: resolvedEndpoint.url,
        token: resolvedEndpoint.token,
        ...(input.user_id === undefined ? {} : { user_id: input.user_id }),
        ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
      }),
    )
  const touchEndpoint = (
    endpointInput: ReconnectingEndpointInput,
    resolvedEndpoint: BackendEndpoint.BackendEndpoint,
  ) =>
    resolvedEndpoint.kind === "orb" && input.touchOrb !== undefined
      ? input.touchOrb(resolvedEndpoint.orb_id).pipe(
          Effect.mapError(
            (error) =>
              new Client.SdkError({
                message: error instanceof Error ? error.message : String(error),
                operation: "backend.touchOrb",
              }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              current.delete(cacheKey(endpointInput))
            }),
          ),
        )
      : Effect.void
  const request = <A>(
    endpointInput: ReconnectingEndpointInput,
    use: (remote: Client.Interface) => Effect.Effect<A, Client.SdkError>,
  ) =>
    resolveEndpoint(endpointInput, false).pipe(
      Effect.tap((next) => touchEndpoint(endpointInput, next)),
      Effect.map(clientForEndpoint),
      Effect.flatMap(use),
      Effect.catchTag("SdkError", (error) =>
        retryableSdkError(error)
          ? resolveEndpoint(endpointInput, true).pipe(
              Effect.tap((next) => touchEndpoint(endpointInput, next)),
              Effect.map(clientForEndpoint),
              Effect.flatMap(use),
            )
          : Effect.fail(error),
      ),
    )
  const stream = <A>(
    endpointInput: ReconnectingEndpointInput,
    use: (remote: Client.Interface) => Stream.Stream<A, Client.SdkError>,
  ) =>
    Stream.unwrap(
      resolveEndpoint(endpointInput, false).pipe(
        Effect.tap((next) => touchEndpoint(endpointInput, next)),
        Effect.map((next) => use(clientForEndpoint(next))),
      ),
    ).pipe(
      Stream.catch((error: Client.SdkError) =>
        retryableSdkError(error)
          ? Stream.unwrap(
              resolveEndpoint(endpointInput, true).pipe(
                Effect.tap((next) => touchEndpoint(endpointInput, next)),
                Effect.map((next) => use(clientForEndpoint(next))),
              ),
            )
          : Stream.fail(error),
      ),
    )

  return {
    backendHealth: () => request({}, (remote) => remote.backendHealth()),
    createThread: (thread) => request(endpointInputFor(thread?.thread_id), (remote) => remote.createThread(thread)),
    createOrbThread: (thread) => request({}, (remote) => remote.createOrbThread(thread)),
    orbChanges: () => request({}, (remote) => remote.orbChanges()),
    orbFiles: (path) => request({}, (remote) => remote.orbFiles(path)),
    orbFile: (path) => request({}, (remote) => remote.orbFile(path)),
    listOrbs: () => request({}, (remote) => remote.listOrbs()),
    getOrbByThread: (threadId) => request({ thread_id: threadId }, (remote) => remote.getOrbByThread(threadId)),
    pauseOrb: (orbId) => request({}, (remote) => remote.pauseOrb(orbId)),
    resumeOrb: (orbId) => request({}, (remote) => remote.resumeOrb(orbId)),
    killOrb: (orbId) => request({}, (remote) => remote.killOrb(orbId)),
    listProjects: () => request({}, (remote) => remote.listProjects()),
    createProject: (project) => request({}, (remote) => remote.createProject(project)),
    getProject: (projectId) => request({}, (remote) => remote.getProject(projectId)),
    updateProject: (projectId, project) => request({}, (remote) => remote.updateProject(projectId, project)),
    setProjectSecret: (projectId, name, secret) =>
      request({}, (remote) => remote.setProjectSecret(projectId, name, secret)),
    deleteProjectSecret: (projectId, name) => request({}, (remote) => remote.deleteProjectSecret(projectId, name)),
    listThreads: (thread) => request({}, (remote) => remote.listThreads(thread)),
    openThread: (threadId, userId) => request({ thread_id: threadId }, (remote) => remote.openThread(threadId, userId)),
    previewThread: (threadId, preview) =>
      request({ thread_id: threadId }, (remote) => remote.previewThread(threadId, preview)),
    archiveThread: (threadId, userId) =>
      request({ thread_id: threadId }, (remote) => remote.archiveThread(threadId, userId)),
    unarchiveThread: (threadId, userId) =>
      request({ thread_id: threadId }, (remote) => remote.unarchiveThread(threadId, userId)),
    setThreadVisibility: (threadId, visibility, userId) =>
      request({ thread_id: threadId }, (remote) => remote.setThreadVisibility(threadId, visibility, userId)),
    compactThread: (threadId, userId) =>
      request({ thread_id: threadId }, (remote) => remote.compactThread(threadId, userId)),
    forkThread: (threadId, forkInput) =>
      request({ thread_id: threadId }, (remote) => remote.forkThread(threadId, forkInput)),
    searchThreads: (search) => request({}, (remote) => remote.searchThreads(search)),
    shareThread: (threadId, userId) =>
      request({ thread_id: threadId }, (remote) => remote.shareThread(threadId, userId)),
    referenceThread: (reference) =>
      request({ thread_id: reference.thread_id }, (remote) => remote.referenceThread(reference)),
    subscribeThreadEvents: (subscription) =>
      stream({ thread_id: subscription.thread_id }, (remote) => remote.subscribeThreadEvents(subscription)),
    setThreadPresence: (presence) =>
      request({ thread_id: presence.thread_id }, (remote) => remote.setThreadPresence(presence)),
    startTurn: (turn) => request({ thread_id: turn.thread_id }, (remote) => remote.startTurn(turn)),
    interruptTurn: (turn) => request({ thread_id: turn.thread_id }, (remote) => remote.interruptTurn(turn)),
    listArtifacts: (artifacts) =>
      request({ thread_id: artifacts.thread_id }, (remote) => remote.listArtifacts(artifacts)),
    getArtifact: (artifactId, userId) => request({}, (remote) => remote.getArtifact(artifactId, userId)),
    connectIde: (connection) => request({}, (remote) => remote.connectIde(connection)),
    disconnectIde: (disconnection) => request({}, (remote) => remote.disconnectIde(disconnection)),
    updateIdeContext: (context) => request({}, (remote) => remote.updateIdeContext(context)),
    ideStatus: () => request({}, (remote) => remote.ideStatus()),
    openIdeFile: (file) => request({}, (remote) => remote.openIdeFile(file)),
    ideNavigationRequests: () => request({}, (remote) => remote.ideNavigationRequests()),
  }
}

const resolveErrorOperation = (error: ReconnectingResolveError) => {
  if ("operation" in error) return `backend.${error.operation}`
  if ("step" in error) return `backend.${error.step}`
  return "backend.resolveEndpoint"
}

const retryableSdkError = (error: Client.SdkError): boolean => error.status === undefined

export const skillsLiveLayer = (
  _command: Args.SkillCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<SkillsLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const { telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer)
  const timeLayer = Time.layer
  const installerLayer = SkillInstaller.liveLayer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(timeLayer))

  return Skills.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(SkillRegistry.layer),
    Layer.provideMerge(installerLayer),
    Layer.provideMerge(configLayer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(telemetryLayer),
  )
}

export const memoryLiveLayer = (
  command: Args.MemoryCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<MemoryLayerOutput, LiveLayerError> => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const redactorLayer = secretRedactorLayer(env)
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer, redactorLayer)
  const memoryStoreLayer = ThreadMemoryStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    Output.layer,
    databaseLayer,
    Migration.layer,
    redactorLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    memoryStoreLayer,
    timeLayer,
    IdGenerator.layer,
    diagnosticsLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const embeddingsLayer = Embeddings.layer(
    Embeddings.optionsFromEnv(env, { openaiConfigured: Live.optionsFromEnv(env).openai !== undefined }),
  )
  const indexerLayer = ThreadMemoryIndexer.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(diagnosticsLayer),
  )

  return Memory.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(indexerLayer),
    Layer.provideMerge(telemetryLayer),
  )
}

export const threadsLiveLayer = (
  command: Args.ThreadCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<Threads.Service, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const dataDir = env.RIKA_DATA_DIR ?? `${workspaceRoot}/.rika`
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const redactorLayer = secretRedactorLayer(env)
  const settingsLayer = Settings.layerFromEnv(env, workspaceRoot)
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer, redactorLayer)
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const workspaceStoreLayer = WorkspaceStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const memoryStoreLayer = ThreadMemoryStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const baseStorageLayer = Layer.mergeAll(
    configLayer,
    Output.layer,
    Input.layer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    workspaceStoreLayer,
    memoryStoreLayer,
    Migration.layer,
    redactorLayer,
    settingsLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
  )
  const projectStoreLayer = ProjectStore.layer.pipe(Layer.provideMerge(baseStorageLayer))
  const orbStoreLayer = OrbStore.layer.pipe(Layer.provideMerge(baseStorageLayer))
  const storageLayer = Layer.mergeAll(baseStorageLayer, projectStoreLayer, orbStoreLayer)
  const migratedStorageLayer = Layer.effectDiscard(
    Migration.migrate().pipe(Effect.andThen(OrbStore.repairUsageIntervals())),
  ).pipe(Layer.provideMerge(storageLayer))
  const storageAndThreadLayer = ThreadService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const permissionConfig = PermissionPolicy.configFromEnv(env)
  const llmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const embeddingsLayer = Embeddings.layer(
    Embeddings.optionsFromEnv(env, { openaiConfigured: Live.optionsFromEnv(env).openai !== undefined }),
  )
  const memoryIndexerLayer = ThreadMemoryIndexer.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const threadMemoryLayer = ThreadMemory.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(storageAndThreadLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(timeLayer),
  )
  const pluginLayer = PluginHost.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(PluginUi.silentLayer),
    Layer.provideMerge(migratedStorageLayer),
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
  const skillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const contextResolverLayer = ContextResolver.layer.pipe(
    Layer.provide(storageAndThreadLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(settingsLayer),
  )
  const managerLayer = OrbManager.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const compactionLayer = CompactionService.fakeLayer({
    compact: (input) =>
      Effect.fail(
        new CompactionService.CompactionError({
          message: "Thread compaction is not available through the tournament runner",
          operation: "compact",
          thread_id: input.thread_id,
        }),
      ),
  })
  const orbMirrorLayer = Layer.succeed(
    OrbMirror.Service,
    OrbMirror.Service.of({
      mirror: () => Effect.void,
      flush: () => Effect.void,
      mirrorRunningOrbsOnce: () => Effect.void,
      syncRunning: () => Effect.void,
    }),
  )
  const threadLiveLayer = ThreadLive.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const presenceLayer = PresenceHub.layer.pipe(Layer.provideMerge(timeLayer))
  const agentBase = Layer.mergeAll(
    migratedStorageLayer,
    storageAndThreadLayer,
    workspaceAccessLayer,
    contextResolverLayer,
    skillLayer,
    skillToolProviderLayer,
    memoryIndexerLayer,
    toolLayer,
    diagnosticsLayer,
    telemetryLayer,
    llmLayer,
    IdeBridge.layer,
  )
  const agentLoopLayer = AgentLoop.layer.pipe(Layer.provideMerge(agentBase))
  const remoteControlLayer = RemoteControl.layerWithLive.pipe(
    Layer.provideMerge(agentLoopLayer),
    Layer.provideMerge(agentBase),
    Layer.provideMerge(compactionLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(orbMirrorLayer),
    Layer.provideMerge(threadLiveLayer),
    Layer.provideMerge(presenceLayer),
  )
  const tournamentTurnControlLayer = Layer.effect(
    TournamentService.TurnControlService,
    Effect.map(RemoteControl.Service, (remote) =>
      TournamentService.TurnControlService.of({
        startTurn: (input) =>
          remote.startTurn(input).pipe(
            Effect.mapError(
              (error) =>
                new TournamentService.TournamentTurnError({
                  message: error instanceof Error ? error.message : String(error),
                  operation: "startTurn",
                  thread_id: input.thread_id,
                  cause: error,
                }),
            ),
          ),
        subscribeThreadEvents: (input) =>
          remote.subscribeThreadEvents(input).pipe(
            Stream.mapError(
              (error) =>
                new TournamentService.TournamentTurnError({
                  message: error instanceof Error ? error.message : String(error),
                  operation: "subscribeThreadEvents",
                  thread_id: input.thread_id,
                  cause: error,
                }),
            ),
          ),
      }),
    ),
  ).pipe(Layer.provideMerge(remoteControlLayer))
  const judgeLayer = JudgeService.layer.pipe(Layer.provideMerge(migratedStorageLayer), Layer.provideMerge(llmLayer))
  const tournamentLayer = TournamentService.layer.pipe(
    Layer.provideMerge(storageAndThreadLayer),
    Layer.provideMerge(judgeLayer),
    Layer.provideMerge(tournamentTurnControlLayer),
    Layer.provideMerge(configLayer),
  )
  const backendLayer = LocalBackend.layerFromInput({ env, cwd })
  const remoteClientLayer = Layer.effect(
    Threads.RemoteClient,
    Effect.gen(function* () {
      const backend = yield* LocalBackend.Service
      const orbs = yield* OrbStore.Service
      const health = yield* BackendEndpoint.Health
      const resumer = yield* BackendEndpoint.OrbResumer
      const settings = yield* Settings.Service
      const snapshot = yield* settings.snapshot
      const resolveEndpoint = (input: ReconnectingEndpointInput) =>
        BackendEndpoint.resolveEndpoint({
          ...input,
          workspace_root: workspaceRoot,
          data_dir: dataDir,
          env,
        }).pipe(
          Effect.provideService(LocalBackend.Service, backend),
          Effect.provideService(OrbStore.Service, orbs),
          Effect.provideService(BackendEndpoint.Health, health),
          Effect.provideService(BackendEndpoint.OrbResumer, resumer),
        )
      return Threads.RemoteClient.of(
        reconnectingClient({ resolveEndpoint, user_id: Ids.UserId.make(snapshot.values.user.name) }),
      )
    }),
  ).pipe(
    Layer.provideMerge(backendLayer),
    Layer.provideMerge(BackendEndpoint.healthLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(BackendEndpoint.orbManagerResumerLayer),
    Layer.provideMerge(managerLayer),
  )
  const baseCommandLayer = Threads.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(Input.layer),
    Layer.provideMerge(storageAndThreadLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provide(remoteClientLayer),
  )
  const commandLayer =
    command.action === "tournament" ? baseCommandLayer.pipe(Layer.provideMerge(tournamentLayer)) : baseCommandLayer

  return commandLayer.pipe(Layer.provideMerge(telemetryLayer))
}

export const orbLiveLayer = (
  _command: Args.OrbCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<OrbLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const redactorLayer = secretRedactorLayer(env)
  const settingsLayer = Settings.layerFromEnv(env, workspaceRoot)
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer, redactorLayer)
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
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
    Output.layer,
    Input.layer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    projectStoreLayer,
    orbStoreLayer,
    Migration.layer,
    redactorLayer,
    settingsLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(
    Migration.migrate().pipe(Effect.andThen(OrbStore.repairUsageIntervals())),
  ).pipe(Layer.provideMerge(storageLayer))
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const activityLayer = OrbActivity.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(timeLayer),
  )
  const managerLayer = OrbManager.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(activityLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const threadLiveLayer = ThreadLive.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const mirrorLayer = OrbMirror.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(threadLiveLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(activityLayer),
  )
  const resolverLayer = BackendEndpoint.resolverLayerFromEnv(env).pipe(
    Layer.provideMerge(LocalBackend.layerFromInput({ env, cwd })),
    Layer.provideMerge(BackendEndpoint.healthLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(BackendEndpoint.orbManagerResumerLayer),
    Layer.provideMerge(managerLayer),
  )
  const shellLayer = OrbShell.layerFromEnv(env).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(resolverLayer),
    Layer.provideMerge(activityLayer),
    Layer.provideMerge(OrbShell.systemLayer),
  )
  const syncLayer = Sync.layer.pipe(Layer.provideMerge(configLayer), Layer.provideMerge(resolverLayer))
  const llmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const judgeLayer = JudgeService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(IdGenerator.layer),
    Layer.provideMerge(timeLayer),
    Layer.provideMerge(llmLayer),
  )
  const tournamentLayer = OrbTournament.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(judgeLayer),
    Layer.provideMerge(syncLayer),
  )

  return Orb.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(mirrorLayer),
    Layer.provideMerge(shellLayer),
    Layer.provideMerge(tournamentLayer),
    Layer.provideMerge(telemetryLayer),
  )
}

export const projectLiveLayer = (
  _command: Args.ProjectCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<ProjectLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const { telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer)
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

  return commandLayer.pipe(Layer.provideMerge(telemetryLayer))
}

export const mcpLiveLayer = (
  _command: Args.McpCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<McpLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const { telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer)
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
  const skillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const commandLayer = Mcp.layerFromInput({ env, cwd }).pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(mcpClientLayer),
    Layer.provideMerge(skillLayer),
  )

  return commandLayer.pipe(Layer.provideMerge(telemetryLayer))
}

export const reviewLiveLayer = (
  command: Args.ReviewCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<ReviewLayerOutput, LiveLayerError> => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const redactorLayer = secretRedactorLayer(env)
  const settingsLayer = Settings.layerFromEnv(env, workspaceRoot)
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer, redactorLayer)
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
  const memoryStoreLayer = ThreadMemoryStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    Output.layer,
    databaseLayer,
    Migration.layer,
    redactorLayer,
    settingsLayer,
    timeLayer,
    IdGenerator.layer,
    artifactLayer,
    mcpApprovalLayer,
    memoryStoreLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const llmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const embeddingsLayer = Embeddings.layer(
    Embeddings.optionsFromEnv(env, { openaiConfigured: Live.optionsFromEnv(env).openai !== undefined }),
  )
  const storageAndThreadLayer = ThreadService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const threadMemoryLayer = ThreadMemory.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(storageAndThreadLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(timeLayer),
  )
  const pluginLayer = PluginHost.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(PluginUi.silentLayer),
    Layer.provideMerge(migratedStorageLayer),
  )
  const specialtyToolLayer = SpecialtyTools.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(llmLayer),
  )
  const subagentToolLayer = BuiltInTools.subagentToolExecutorLayerFromPermissionConfig(
    PermissionPolicy.configFromEnv(env),
  ).pipe(
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
  const reviewServiceLayer = ReviewService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(CheckRegistry.layer.pipe(Layer.provideMerge(configLayer))),
    Layer.provideMerge(subagentLayer),
  )
  const commandLayer = Review.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(reviewServiceLayer),
    Layer.provideMerge(telemetryLayer),
  )

  return commandLayer
}

export const extensionsLiveLayer = (
  _command: Args.ExtensionCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<ExtensionsLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const { telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer)
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const timeLayer = Time.layer
  const artifactLayer = ArtifactStore.layer.pipe(Layer.provideMerge(databaseLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    Output.layer,
    databaseLayer,
    Migration.layer,
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
    artifactLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(Migration.migrate()).pipe(Layer.provideMerge(storageLayer))
  const selfExtensionLayer = SelfExtension.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const commandLayer = Extensions.layer.pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(selfExtensionLayer),
    Layer.provideMerge(telemetryLayer),
  )

  return commandLayer
}

export const ideLiveLayer = (
  _command: Args.IdeCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<IdeLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const { telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer)
  return Ide.layer.pipe(Layer.provideMerge(Output.layer), Layer.provideMerge(telemetryLayer))
}

export const configLiveLayer = (
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<CliConfig.Service, LiveLayerError, Output.Service> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const { telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer)
  return CliConfig.layerFromInput({ env, cwd }).pipe(Layer.provideMerge(telemetryLayer))
}

export const doctorLiveLayer = (
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<DoctorLayerOutput, LiveLayerError> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const { telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer)
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const baseStorageLayer = Layer.mergeAll(configLayer, databaseLayer, Migration.layer, Time.layer, IdGenerator.layer)
  const orbStoreLayer = OrbStore.layer.pipe(Layer.provideMerge(baseStorageLayer))
  const storageLayer = Layer.mergeAll(baseStorageLayer, orbStoreLayer)
  const migratedStorageLayer = Layer.effectDiscard(
    Migration.migrate().pipe(Effect.andThen(OrbStore.repairUsageIntervals())),
  ).pipe(Layer.provideMerge(storageLayer))
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const settingsLayer = Settings.layerFromEnv(env, workspaceRoot)
  return Doctor.layerFromInput({ env, cwd }).pipe(
    Layer.provideMerge(Output.layer),
    Layer.provideMerge(LocalBackend.layerFromInput({ env, cwd })),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(orbStoreLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(BackendEndpoint.healthLayer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(telemetryLayer),
  )
}

export const serverLiveLayer = (
  command: Args.ServerCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<ServerLayerOutput, LiveLayerError> => {
  const workspaceRoot = command.workspace_root ?? env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const redactorLayer = secretRedactorLayer(
    env,
    command.token === undefined ? [] : [{ label: "RIKA_SERVER_TOKEN", value: command.token }],
  )
  const settingsLayer = Settings.layerFromEnv(env, workspaceRoot)
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer, redactorLayer)
  const databaseLayer = command.ephemeral ? Database.memoryLayer : Database.layer.pipe(Layer.provideMerge(configLayer))
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
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const llmLayer = Live.layer(Live.optionsFromEnv(env)).pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const permissionConfig = PermissionPolicy.configFromEnv(env)
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    artifactLayer,
    mcpApprovalLayer,
    workspaceStoreLayer,
    memoryStoreLayer,
    projectStoreLayer,
    orbStoreLayer,
    Migration.layer,
    redactorLayer,
    settingsLayer,
    ThreadEventLog.layer.pipe(Layer.provideMerge(redactorLayer)),
    ThreadProjection.layer,
    timeLayer,
    IdGenerator.layer,
  )
  const migratedStorageLayer = Layer.effectDiscard(
    Migration.migrate().pipe(Effect.andThen(OrbStore.repairUsageIntervals())),
  ).pipe(Layer.provideMerge(storageLayer))
  const pluginLayer = PluginHost.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(PluginUi.silentLayer),
    Layer.provideMerge(migratedStorageLayer),
  )
  const embeddingsLayer = Embeddings.layer(
    Embeddings.optionsFromEnv(env, { openaiConfigured: Live.optionsFromEnv(env).openai !== undefined }),
  )
  const memoryIndexerLayer = ThreadMemoryIndexer.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const storageAndThreadLayer = ThreadService.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const threadMemoryLayer = ThreadMemory.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(storageAndThreadLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(timeLayer),
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
  const skillLayer = SkillRegistry.layer.pipe(Layer.provideMerge(configLayer))
  const workspaceAccessLayer = WorkspaceAccess.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const contextResolverLayer = ContextResolver.layer.pipe(
    Layer.provide(storageAndThreadLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(embeddingsLayer),
    Layer.provideMerge(settingsLayer),
  )
  const baseLayer = Layer.mergeAll(
    Output.layer,
    migratedStorageLayer,
    storageAndThreadLayer,
    workspaceAccessLayer,
    contextResolverLayer,
    skillLayer,
    skillToolProviderLayer,
    memoryIndexerLayer,
    toolLayer,
    llmLayer,
    artifactLayer,
    IdeBridge.layer,
    diagnosticsLayer,
    telemetryLayer,
  )
  const activityLayer = OrbActivity.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(timeLayer),
  )
  const managerLayer = OrbManager.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(activityLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const threadLiveLayer = ThreadLive.layer.pipe(Layer.provideMerge(migratedStorageLayer))
  const presenceLayer = PresenceHub.layer.pipe(Layer.provideMerge(timeLayer))
  const agentLayer = AgentLoop.layer.pipe(Layer.provideMerge(baseLayer))
  const compactionLayer = CompactionService.layer.pipe(Layer.provideMerge(baseLayer))
  const orbMirrorLayer = OrbMirror.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(threadLiveLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(activityLayer),
  )
  const remoteLayer = RemoteControl.layerWithLive.pipe(
    Layer.provideMerge(agentLayer),
    Layer.provideMerge(compactionLayer),
    Layer.provideMerge(baseLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(threadLiveLayer),
    Layer.provideMerge(presenceLayer),
    Layer.provideMerge(orbMirrorLayer),
  )
  const orbMirrorStartupLayer = Layer.effectDiscard(
    Effect.repeat(
      OrbMirror.syncRunning().pipe(Effect.catch((error) => Diagnostics.emit(orbMirrorSyncFailure(error)))),
      Schedule.spaced("5 seconds"),
    ).pipe(Effect.forkScoped),
  ).pipe(Layer.provideMerge(orbMirrorLayer), Layer.provide(diagnosticsLayer))
  const httpLayer = HttpServer.layerFromEnv(env).pipe(
    Layer.provideMerge(remoteLayer),
    Layer.provideMerge(presenceLayer),
  )
  const commandLayer = Layer.mergeAll(
    Server.layer.pipe(Layer.provideMerge(Output.layer), Layer.provideMerge(httpLayer)),
    orbMirrorStartupLayer,
  )

  return commandLayer
}

export const syncLiveLayer = (
  _command: Args.SyncCommand,
  env: Record<string, string | undefined>,
  cwd: string,
): Layer.Layer<SyncLayerOutput, LiveLayerError, Output.Service> => {
  const workspaceRoot = env.RIKA_WORKSPACE_ROOT ?? cwd
  const configLayer = runtimeConfigLayer(env, workspaceRoot)
  const databaseLayer = Database.layer.pipe(Layer.provideMerge(configLayer))
  const redactorLayer = secretRedactorLayer(env)
  const settingsLayer = Settings.layerFromEnv(env, workspaceRoot)
  const { diagnosticsLayer, telemetryLayer } = telemetryLayers(env, workspaceRoot, configLayer, redactorLayer)
  const timeLayer = Time.layer
  const mcpApprovalLayer = McpApprovalStore.layer.pipe(Layer.provideMerge(databaseLayer), Layer.provideMerge(timeLayer))
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
  const sandboxLayer = SandboxClient.layer.pipe(Layer.provideMerge(configLayer))
  const storageLayer = Layer.mergeAll(
    configLayer,
    databaseLayer,
    redactorLayer,
    settingsLayer,
    mcpApprovalLayer,
    Migration.layer,
    timeLayer,
    IdGenerator.layer,
    projectStoreLayer,
    orbStoreLayer,
  )
  const migratedStorageLayer = Layer.effectDiscard(
    Migration.migrate().pipe(Effect.andThen(OrbStore.repairUsageIntervals())),
  ).pipe(Layer.provideMerge(storageLayer))
  const managerLayer = OrbManager.layer.pipe(
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(sandboxLayer),
    Layer.provideMerge(diagnosticsLayer),
  )
  const resolverLayer = BackendEndpoint.resolverLayerFromEnv(env).pipe(
    Layer.provideMerge(LocalBackend.layerFromInput({ env, cwd })),
    Layer.provideMerge(BackendEndpoint.healthLayer),
    Layer.provideMerge(migratedStorageLayer),
    Layer.provideMerge(BackendEndpoint.orbManagerResumerLayer),
    Layer.provideMerge(managerLayer),
  )

  return Sync.layer.pipe(
    Layer.provideMerge(configLayer),
    Layer.provideMerge(resolverLayer),
    Layer.provideMerge(telemetryLayer),
  )
}

export type LiveLayerOutput =
  | AgentLoop.Service
  | ArtifactStore.Service
  | Embeddings.Service
  | Config.Service
  | ContextResolver.Service
  | Database.Service
  | BackendEndpoint.Health
  | BackendEndpoint.OrbResumer
  | BackendEndpoint.Resolver
  | Execute.Service
  | IdGenerator.Service
  | LocalBackend.Service
  | Migration.Service
  | OrbManager.Service
  | McpApprovalStore.Service
  | Output.Service
  | PluginHost.Service
  | ProjectStore.Service
  | Router.Service
  | SandboxClient.Service
  | Settings.Service
  | SkillRegistry.Service
  | SkillToolProvider.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | ThreadEventLog.Service
  | ThreadMemoryStore.Service
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
  | Settings.Service
  | Time.Service

export type InteractiveLayerOutput =
  | Adapter.Service
  | AgentLoop.Service
  | ArtifactStore.Service
  | CheckRegistry.Service
  | Embeddings.Service
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
  | SkillToolProvider.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | Ticker.Service
  | ThreadEventLog.Service
  | ThreadMemoryIndexer.Service
  | ThreadMemoryStore.Service
  | ThreadProjection.Service
  | ThreadService.Service
  | Time.Service
  | ToolExecutor.Service
  | WorkspaceStore.Service

export type InteractiveRemoteLayerOutput =
  | Adapter.Service
  | BackendEndpoint.Health
  | BackendEndpoint.OrbResumer
  | Config.Service
  | Database.Service
  | IdGenerator.Service
  | LocalBackend.Service
  | Migration.Service
  | OrbActivity.Service
  | OrbManager.Service
  | OrbStore.Service
  | ProjectStore.Service
  | RemoteSession.Service
  | SandboxClient.Service
  | Ticker.Service
  | Time.Service

export type ThreadsLayerOutput =
  | AgentLoop.Service
  | ArtifactStore.Service
  | Config.Service
  | ContextResolver.Service
  | Database.Service
  | Diagnostics.Service
  | IdGenerator.Service
  | IdeBridge.Service
  | Input.Service
  | JudgeService.Service
  | Migration.Service
  | McpApprovalStore.Service
  | Embeddings.Service
  | OrbManager.Service
  | OrbStore.Service
  | Output.Service
  | PluginHost.Service
  | PluginUi.Service
  | ThreadEventLog.Service
  | ThreadLive.Service
  | ThreadMemoryIndexer.Service
  | ThreadMemoryStore.Service
  | ThreadProjection.Service
  | ThreadService.Service
  | ToolExecutor.Service
  | TournamentService.Service
  | TournamentService.TurnControlService
  | Threads.Service
  | Time.Service
  | WorkspaceAccess.Service
  | WorkspaceStore.Service

export type OrbLayerOutput =
  | ArtifactStore.Service
  | BackendEndpoint.Health
  | BackendEndpoint.OrbResumer
  | BackendEndpoint.Resolver
  | Config.Service
  | Database.Service
  | IdGenerator.Service
  | Input.Service
  | LocalBackend.Service
  | Migration.Service
  | Orb.Service
  | OrbActivity.Service
  | OrbManager.Service
  | OrbMirror.Service
  | OrbShell.Service
  | OrbShell.System
  | OrbTournament.Service
  | OrbStore.Service
  | Output.Service
  | ProjectStore.Service
  | SandboxClient.Service
  | ThreadEventLog.Service
  | ThreadLive.Service
  | ThreadProjection.Service
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

export type SkillsLayerOutput =
  | Config.Service
  | Output.Service
  | SkillInstaller.Service
  | SkillRegistry.Service
  | Skills.Service
  | Time.Service

export type MemoryLayerOutput =
  | Config.Service
  | Database.Service
  | Diagnostics.Service
  | Embeddings.Service
  | IdGenerator.Service
  | Memory.Service
  | Migration.Service
  | Output.Service
  | ThreadEventLog.Service
  | ThreadMemoryIndexer.Service
  | ThreadMemoryStore.Service
  | ThreadProjection.Service
  | Time.Service

export type SyncLayerOutput =
  | BackendEndpoint.OrbResumer
  | BackendEndpoint.Resolver
  | Config.Service
  | OrbManager.Service
  | OrbStore.Service
  | ProjectStore.Service
  | SandboxClient.Service
  | Sync.Service

export type McpLayerOutput =
  | Config.Service
  | Database.Service
  | Mcp.Service
  | McpApprovalStore.Service
  | McpClient.Service
  | Migration.Service
  | Output.Service
  | SkillRegistry.Service
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
  | ThreadProjection.Service
  | Time.Service

export type IdeLayerOutput = Output.Service | Ide.Service

export type DoctorLayerOutput =
  | Config.Service
  | Database.Service
  | Doctor.Service
  | IdGenerator.Service
  | LocalBackend.Service
  | Migration.Service
  | OrbStore.Service
  | Output.Service
  | SandboxClient.Service
  | Settings.Service
  | Time.Service
  | BackendEndpoint.Health

export type ServerLayerOutput =
  | AgentLoop.Service
  | ArtifactStore.Service
  | Embeddings.Service
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
  | OrbManager.Service
  | OrbMirror.Service
  | OrbActivity.Service
  | OrbStore.Service
  | ProjectStore.Service
  | SandboxClient.Service
  | Server.Service
  | SkillRegistry.Service
  | SkillToolProvider.Service
  | SpecialtyTools.Service
  | SubagentRuntime.Service
  | ThreadEventLog.Service
  | ThreadLive.Service
  | ThreadMemoryIndexer.Service
  | ThreadMemoryStore.Service
  | ThreadProjection.Service
  | ThreadService.Service
  | Time.Service
  | ToolExecutor.Service
  | WorkspaceAccess.Service
  | WorkspaceStore.Service

export type LiveLayerError =
  | BackendEndpoint.BackendEndpointError
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
  | Settings.SettingsError
  | ThreadEventLog.ThreadEventLogError
  | ThreadMemoryStore.ThreadMemoryStoreError
  | ThreadProjection.ThreadProjectionError
