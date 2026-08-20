#!/usr/bin/env bun
import * as ProductOperation from "@rika/product/product-operation"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { resolveProfileDataPaths } from "@rika/configuration/profile-data-paths"
import { probeNativeAsset } from "@rika/terminal/opentui-surface"
import type { ModeConfiguration } from "@rika/terminal/terminal-state"
import { FetchHttpClient } from "effect/unstable/http"
import { Config, Console, Context, Effect, Layer, Option, Path } from "effect"
import { Command } from "effect/unstable/cli"
import { command, version } from "../../command/root/rika-command"
import { interactiveTui } from "./interactive-process-loop"
import { layer as serverLayer } from "../../transport/client/server-client-transport"
import { globalPaths, workspacePaths } from "@rika/configuration/configuration-paths"
import { provideLayerScoped } from "./process-layer"
import { makeDispatcherLayer } from "./process-startup-dispatcher"
import { saveModePreference } from "./mode-preference"
import { serverProcessRuntime } from "../../private-runtime-role"

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

export const start = () => {
  const nativeProbe = Effect.runSync(Config.option(Config.string("RIKA_INTERNAL_OPENTUI_NATIVE_PROBE")))
  if (Option.contains(nativeProbe, "1")) {
    Effect.runSync(Console.log(probeNativeAsset()))
    process.exit(0)
  }
  const environment = Effect.runSync(
    Config.all({
      hostDataRoot: Config.option(Config.string("RIKA_INTERNAL_SERVER_DATA_ROOT")),
      home: Config.option(Config.string("HOME")),
      database: Config.option(Config.string("RIKA_DATABASE")),
      visual: Config.option(Config.string("VISUAL")),
      editor: Config.option(Config.string("EDITOR")),
      testModelResponse: Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE")),
      testModelScript: Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT")),
      testMediaAnalyzerResponse: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_RESPONSE")),
      testMediaAnalyzerError: Config.option(Config.string("RIKA_TEST_MEDIA_ANALYZER_ERROR")),
      serverProfile: Config.option(Config.string("RIKA_INTERNAL_SERVER_PROFILE")),
      serverGrace: Config.option(Config.string("RIKA_INTERNAL_SERVER_GRACE")),
      recoveryAbandon: Config.option(Config.string("RIKA_INTERNAL_RECOVERY_ABANDON")),
      serverStartupHold: Config.option(Config.string("RIKA_INTERNAL_SERVER_STARTUP_HOLD")),
      serverHost: Config.option(Config.string("RIKA_INTERNAL_SERVER_HOST")),
    }),
  )
  const hostDataRoot = environment.hostDataRoot._tag === "Some" ? environment.hostDataRoot.value : undefined
  const home = environment.home._tag === "Some" ? environment.home.value : process.cwd()
  const paths = resolveProfileDataPaths({
    home,
    hostDataRoot,
    productDatabase: environment.database._tag === "Some" ? environment.database.value : undefined,
  })
  const database = paths.database
  const globalLayout = globalPaths(home)
  const workspaceLayout = workspacePaths(process.cwd())
  const globalConfig = globalLayout.settings
  const workspaceConfig = workspaceLayout.settings
  let editor: string | undefined
  if (environment.visual._tag === "Some") editor = environment.visual.value
  else if (environment.editor._tag === "Some") editor = environment.editor.value
  const serverRuntime = serverProcessRuntime({
    packaged: import.meta.path.startsWith("/$bunfs/"),
    executable: process.execPath,
    packagedEntrypoint: join(dirname(process.execPath), "rika"),
    sourceEntrypoint: join(import.meta.dir, "..", "..", "client-main.ts"),
  })
  let clientModeConfiguration: ModeConfiguration | undefined
  const clientOwnedInteractiveFunction = interactiveTui({
    editor,
    modeConfiguration: () => clientModeConfiguration,
    rememberMode: (mode) => saveModePreference(paths.dataRoot, mode).pipe(Effect.ignore),
  })

  const dispatcherLayer = makeDispatcherLayer({
    database,
    globalConfig,
    workspaceConfig,
    serverRuntime,
    environment,
    version,
    clientOwnedInteractiveFunction,
    setClientModeConfiguration: (configuration) => {
      clientModeConfiguration = configuration
    },
  })
  const clientProgram = main.pipe(
    provideLayerScoped(
      Layer.mergeAll(
        BunServices.layer,
        BunCrypto.layer,
        FetchHttpClient.layer,
        dispatcherLayer.pipe(Layer.provide(serverLayer)),
      ),
    ),
  )
  BunRuntime.runMain(clientProgram)
}
