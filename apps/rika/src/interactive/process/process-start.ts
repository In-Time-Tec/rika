#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as ModelRouteLabel from "@rika/configuration/model-route-label"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/product/product-operation-service"
import * as ResidentHandshake from "@rika/product/resident-service-handshake"
import * as ResidentService from "@rika/product/resident-service"
import * as DataRoot from "@rika/configuration/canonical-data-root"
import { resolveProfileDataPaths } from "@rika/configuration/profile-data-paths"
import { create as createTui, probeNativeAsset } from "@rika/terminal/opentui-surface"
import type { Model } from "@rika/terminal/terminal-state"
type ModeRoutes = Model["modeRoutes"]
import { commands } from "@rika/terminal/terminal-state-reducer"
import { FetchHttpClient } from "effect/unstable/http"
import {
  Cause,
  Clock,
  Config,
  Console,
  Context,
  Effect,
  Layer,
  Option,
  Path,
  References,
  Runtime,
  Schema,
} from "effect"
import { Command } from "effect/unstable/cli"
import { command, version } from "../../command"
import * as InteractiveController from "../controller/interactive-controller"
import { interactiveTui } from "./interactive-process-loop"
import * as Logging from "../../logging"
import { relaunchArguments } from "../input/relaunch-input"
import { layer as residentLayer } from "../../resident-client-transport"
import * as ResidentProcessStartup from "../../resident-process-startup"
import { globalPaths, workspacePaths } from "@rika/configuration/configuration-paths"
import { provideLayerScoped } from "./process-layer"
import { loadSettingsFile, failureKind, withClientWorkspace } from "./process-configuration"

const main = Command.run(command, { version }).pipe(
  Effect.catchTags({
    OperationUnavailable: (error: ProductOperation.OperationUnavailable) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
    InvalidInput: (error: ProductOperation.InvalidInput) =>
      Console.error(error.message).pipe(Effect.andThen(Effect.fail(error))),
  }),
)

const startupPathService = Effect.runSync(Effect.scoped(Layer.build(Path.layer))).pipe((context) =>
  Context.get(context, Path.Path),
)
const dirname = startupPathService.dirname
const join = startupPathService.join

export interface InteractiveTuiOptions {
  readonly editor?: string | undefined
  readonly modeRoutes?: (() => ModeRoutes | undefined) | undefined
  readonly makeRenderer?: NonNullable<Parameters<typeof createTui>[0]["makeRenderer"]>
  readonly writeTerminalTitle?: (sequence: string) => void
}

export const start = () => {
  const nativeProbe = Effect.runSync(Config.option(Config.string("RIKA_INTERNAL_OPENTUI_NATIVE_PROBE")))
  if (Option.contains(nativeProbe, "1")) {
    Effect.runSync(Console.log(probeNativeAsset()))
    process.exit(0)
  }
  const environment = Effect.runSync(
    Config.all({
      hostDataRoot: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_DATA_ROOT")),
      home: Config.option(Config.string("HOME")),
      database: Config.option(Config.string("RIKA_DATABASE")),
      executionDatabase: Config.option(Config.string("RIKA_EXECUTION_DATABASE")),
      visual: Config.option(Config.string("VISUAL")),
      editor: Config.option(Config.string("EDITOR")),
      testModelResponse: Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE")),
      testModelScript: Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT")),
      testMediaAnalyzerResponse: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_RESPONSE")),
      testMediaAnalyzerError: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_ERROR")),
      residentProfile: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_PROFILE")),
      residentGrace: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_GRACE")),
      recoveryAbandon: Config.option(Config.string("RIKA_INTERNAL_RECOVERY_ABANDON")),
      residentStartupHold: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_STARTUP_HOLD")),
      residentHost: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_HOST")),
      runtimeRestarted: Config.option(Config.string("RIKA_INTERNAL_RUNTIME_RESTARTED")),
      restartThread: Config.option(Config.string("RIKA_INTERNAL_RESTART_THREAD")),
      launcherExecutable: Config.option(Config.string("RIKA_INTERNAL_LAUNCHER_EXECUTABLE")),
      launchArguments: Config.option(Config.string("RIKA_INTERNAL_LAUNCH_ARGUMENTS")),
      runtimeRestartAttempt: Config.option(Config.string("RIKA_INTERNAL_RUNTIME_RESTART_ATTEMPT")),
    }),
  )
  const runtimeRestarted = environment.runtimeRestarted._tag === "Some" && environment.runtimeRestarted.value === "1"
  const restartThreadId = environment.restartThread._tag === "Some" ? environment.restartThread.value : undefined
  let runtimeRestartRequest: { readonly threadId?: string } | undefined
  const hostDataRoot = environment.hostDataRoot._tag === "Some" ? environment.hostDataRoot.value : undefined
  const home = environment.home._tag === "Some" ? environment.home.value : process.cwd()
  const paths = resolveProfileDataPaths({
    home,
    hostDataRoot,
    productDatabase: environment.database._tag === "Some" ? environment.database.value : undefined,
    executionDatabase: environment.executionDatabase._tag === "Some" ? environment.executionDatabase.value : undefined,
  })
  const database = paths.database
  const executionDatabase = paths.executionDatabase
  const globalLayout = globalPaths(home)
  const workspaceLayout = workspacePaths(process.cwd())
  const globalConfig = globalLayout.settings
  const workspaceConfig = workspaceLayout.settings
  let editor: string | undefined
  if (environment.visual._tag === "Some") editor = environment.visual.value
  else if (environment.editor._tag === "Some") editor = environment.editor.value
  const residentRuntime = import.meta.path.startsWith("/$bunfs/")
    ? { executable: join(dirname(process.execPath), ".rika-resident"), arguments: [] }
    : { executable: process.execPath, arguments: [join(import.meta.dir, "resident-main.ts")] }
  let clientModeRoutes: ModeRoutes | undefined
  const clientOwnedInteractiveFunction = interactiveTui({ editor, modeRoutes: () => clientModeRoutes })

  const observedProgram = <A, E>(role: Logging.ProcessRole, dataRoot: string, program: Effect.Effect<A, E>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((startedAt) =>
        Effect.logInfo("process.started").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const globalSettings = yield* loadSettingsFile(globalConfig)
              const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
              const effectiveConfig = yield* ConfigurationService.effectiveConfiguration().pipe(
                provideLayerScoped(
                  ConfigurationService.memoryConfigurationLayer({
                    global: globalSettings,
                    workspace: workspaceSettings,
                  }),
                ),
              )
              clientModeRoutes = ModelRouteLabel.modeRouteLabels(effectiveConfig.settings) as ModeRoutes
              return yield* program.pipe(
                Effect.provideService(
                  References.MinimumLogLevel,
                  Logging.minimumLevel(effectiveConfig.settings.logging.level),
                ),
              )
            }),
          ),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("process.failed").pipe(Effect.annotateLogs("rika.failure.kind", failureKind(cause))),
          ),
          Effect.ensuring(Effect.logInfo("process.stopped")),
          Effect.annotateLogs({
            "rika.process.role": role,
            "rika.process.instance": `${startedAt}-${process.pid}`,
            "rika.process.pid": process.pid,
            "rika.version": version,
          }),
        ),
      ),
      provideLayerScoped(
        Layer.merge(
          Logging.layer({ dataRoot, role, version }).pipe(Layer.provide(BunServices.layer)),
          BunServices.layer,
        ),
      ),
    )
  const dispatcherLayer = Layer.effect(
    Operation.Service,
    Effect.gen(function* () {
      const resident = yield* ResidentService.Service
      return Operation.Service.of({
        run: Effect.fn("Operation.dispatch")((input) =>
          DataRoot.canonicalDataRoot(database, executionDatabase).pipe(
            Effect.flatMap((dataRoot) =>
              observedProgram(
                "client",
                dataRoot,
                Effect.scoped(
                  Effect.gen(function* () {
                    const workspaceInput = withClientWorkspace(input, process.cwd())
                    const clientInput =
                      workspaceInput._tag === "Interactive" && restartThreadId !== undefined
                        ? { ...workspaceInput, threadId: restartThreadId, last: false }
                        : workspaceInput
                    const requestRuntimeRestart = (error: ResidentService.ResidentRestartRequired) =>
                      Effect.sync(() => {
                        runtimeRestartRequest = error.threadId === undefined ? {} : { threadId: error.threadId }
                      }).pipe(
                        Effect.andThen(ResidentProcessStartup.signalRuntimeRestart(error.threadId).pipe(Effect.ignore)),
                        Effect.andThen(
                          ProductOperation.OperationUnavailable.make({
                            operation: clientInput._tag,
                            message: "Rika was upgraded; restarting this session",
                          }),
                        ),
                      )
                    let clientKind: ResidentHandshake.Handshake["clientKind"]
                    if (clientInput._tag === "Interactive") clientKind = "interactive"
                    else if (clientInput._tag === "Run") clientKind = "run"
                    else if (clientInput._tag === "Review") clientKind = "review"
                    else if (clientInput._tag === "Workflow") clientKind = "workflow"
                    else clientKind = "product"
                    const connected = yield* Effect.result(
                      resident
                        .getOrCreate({
                          profile: "default",
                          dataRoot,
                          ...(runtimeRestarted ? { allowSupersede: false } : {}),
                          clientKind,
                          startHost: () =>
                            ResidentProcessStartup.spawn({
                              executable: residentRuntime.executable,
                              arguments: residentRuntime.arguments,
                              environment: {
                                RIKA_INTERNAL_RESIDENT_HOST: "1",
                                RIKA_INTERNAL_RESIDENT_PROFILE: "default",
                                RIKA_INTERNAL_RESIDENT_DATA_ROOT: dataRoot,
                                ...(environment.residentGrace._tag === "None"
                                  ? {}
                                  : { RIKA_INTERNAL_RESIDENT_GRACE: environment.residentGrace.value }),
                                ...(environment.residentStartupHold._tag === "None"
                                  ? {}
                                  : { RIKA_INTERNAL_RESIDENT_STARTUP_HOLD: environment.residentStartupHold.value }),
                                ...(environment.testModelResponse._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MODEL_RESPONSE: environment.testModelResponse.value }),
                                ...(environment.testModelScript._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MODEL_SCRIPT: environment.testModelScript.value }),
                                ...(environment.testMediaAnalyzerResponse._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MEDIA_ANALYZER_RESPONSE: environment.testMediaAnalyzerResponse.value }),
                                ...(environment.testMediaAnalyzerError._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MEDIA_ANALYZER_ERROR: environment.testMediaAnalyzerError.value }),
                              },
                            }).pipe(Effect.tap(() => Effect.logInfo("resident.spawned"))),
                        })
                        .pipe(provideLayerScoped(Layer.merge(BunServices.layer, BunCrypto.layer))),
                    )
                    if (connected._tag === "Success") {
                      const connection = connected.success
                      yield* Effect.logInfo("resident.connected")
                      yield* connection
                        .run(clientInput, {
                          stdout: (text) => Effect.sync(() => process.stdout.write(text)),
                          stderr: (text) => Effect.sync(() => process.stderr.write(text)),
                          ...(clientInput._tag === "Interactive"
                            ? { interactive: clientOwnedInteractiveFunction }
                            : {}),
                        })
                        .pipe(
                          Effect.tapError((error) =>
                            Schema.is(ResidentService.ResidentRestartRequired)(error)
                              ? Effect.sync(() => {
                                  runtimeRestartRequest =
                                    error.threadId === undefined ? {} : { threadId: error.threadId }
                                }).pipe(
                                  Effect.andThen(
                                    ResidentProcessStartup.signalRuntimeRestart(error.threadId).pipe(Effect.ignore),
                                  ),
                                )
                              : Effect.void,
                          ),
                          Effect.mapError((error) =>
                            Schema.is(ProductOperation.OperationUnavailable)(error)
                              ? error
                              : ProductOperation.OperationUnavailable.make({
                                  operation: clientInput._tag,
                                  message: Schema.is(ResidentService.ResidentRestartRequired)(error)
                                    ? "Rika was upgraded; restarting this session"
                                    : error.message,
                                }),
                          ),
                          Effect.ensuring(connection.close),
                        )
                      return
                    }
                    if (Schema.is(ResidentService.ResidentRestartRequired)(connected.failure))
                      return yield* requestRuntimeRestart(connected.failure)
                    return yield* ProductOperation.OperationUnavailable.make({
                      operation: clientInput._tag,
                      message: connected.failure.message,
                    })
                  }),
                ).pipe(
                  Effect.tap(() => Effect.logInfo("operation.completed")),
                  Effect.tapError(() => Effect.logError("operation.failed")),
                  Effect.annotateLogs("rika.operation", input._tag),
                ),
              ),
            ),
            provideLayerScoped(BunServices.layer),
            Effect.mapError((error) =>
              Schema.is(ProductOperation.OperationUnavailable)(error)
                ? error
                : ProductOperation.OperationUnavailable.make({ operation: input._tag, message: String(error) }),
            ),
          ),
        ),
      })
    }),
  )
  const clientProgram = main.pipe(
    provideLayerScoped(
      Layer.mergeAll(
        BunServices.layer,
        BunCrypto.layer,
        FetchHttpClient.layer,
        dispatcherLayer.pipe(Layer.provide(residentLayer)),
      ),
    ),
  )
  BunRuntime.runMain(clientProgram, {
    teardown: (exit, onExit) => {
      if (runtimeRestartRequest !== undefined && environment.launcherExecutable._tag === "Some") {
        const attempt =
          environment.runtimeRestartAttempt._tag === "Some" ? Number(environment.runtimeRestartAttempt.value) : 0
        if (!Number.isSafeInteger(attempt) || attempt < 0 || attempt >= 3) {
          Effect.runSync(Console.error("Rika could not finish upgrading. Reinstall Rika, then run it again."))
          return onExit(2)
        }
        let arguments_: ReadonlyArray<string> = relaunchArguments()
        if (environment.launchArguments._tag === "Some")
          try {
            const decoded = JSON.parse(environment.launchArguments.value)
            if (Array.isArray(decoded) && decoded.every((item) => typeof item === "string")) arguments_ = decoded
          } catch {}
        const inherited = Object.fromEntries(
          Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        )
        inherited.RIKA_INTERNAL_RUNTIME_RESTARTED = "1"
        inherited.RIKA_INTERNAL_RUNTIME_RESTART_ATTEMPT = String(attempt + 1)
        if (runtimeRestartRequest.threadId === undefined) delete inherited.RIKA_INTERNAL_RESTART_THREAD
        else inherited.RIKA_INTERNAL_RESTART_THREAD = runtimeRestartRequest.threadId
        delete inherited.RIKA_INTERNAL_LAUNCHER_EXECUTABLE
        delete inherited.RIKA_INTERNAL_LAUNCH_ARGUMENTS
        try {
          const execve = process.execve
          if (execve === undefined) throw new Error("process image replacement is unavailable")
          execve(environment.launcherExecutable.value, [environment.launcherExecutable.value, ...arguments_], inherited)
        } catch (cause) {
          Effect.runSync(Console.error(`Rika could not restart after upgrading: ${String(cause)}`))
          return onExit(2)
        }
      }
      if (runtimeRestartRequest !== undefined) return onExit(ResidentService.ServiceRuntime.runtimeRestartExitCode)
      Runtime.defaultTeardown(exit, onExit)
    },
  })
}
