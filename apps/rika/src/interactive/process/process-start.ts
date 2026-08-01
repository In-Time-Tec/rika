#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ResidentService from "@rika/product/resident-service"
import { resolveProfileDataPaths } from "@rika/configuration/profile-data-paths"
import { create as createTui, probeNativeAsset } from "@rika/terminal/opentui-surface"
import type { Model } from "@rika/terminal/terminal-state"
type ModeRoutes = Model["modeRoutes"]
import { FetchHttpClient } from "effect/unstable/http"
import { Config, Console, Context, Effect, Layer, Option, Path, Runtime } from "effect"
import { Command } from "effect/unstable/cli"
import { command, version } from "../../command/root/rika-command"
import { interactiveTui } from "./interactive-process-loop"
import { relaunchArguments } from "../../release/relaunch-argument"
import { layer as residentLayer } from "../../transport/client/resident-client-transport"
import { globalPaths, workspacePaths } from "@rika/configuration/configuration-paths"
import { provideLayerScoped } from "./process-layer"
import { makeDispatcherLayer } from "./process-startup-dispatcher"

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
    : { executable: process.execPath, arguments: [join(import.meta.dir, "..", "..", "resident-main.ts")] }
  let clientModeRoutes: ModeRoutes | undefined
  const clientOwnedInteractiveFunction = interactiveTui({ editor, modeRoutes: () => clientModeRoutes })

  const dispatcherLayer = makeDispatcherLayer({
    database,
    executionDatabase,
    globalConfig,
    workspaceConfig,
    residentRuntime,
    environment,
    restartThreadId,
    runtimeRestarted,
    version,
    clientOwnedInteractiveFunction,
    setClientModeRoutes: (routes) => {
      clientModeRoutes = routes
    },
    runtimeRestartRequest: {
      get value() {
        return runtimeRestartRequest
      },
      set value(value) {
        runtimeRestartRequest = value
      },
    },
  })
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
