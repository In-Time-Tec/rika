import * as ModelRouteLabel from "@rika/configuration/model-route-label"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/product/product-operation-service"
import * as ProductOperation from "@rika/product/product-operation"
import * as ServerHandshake from "@rika/product/server-service-handshake"
import * as ServerService from "@rika/product/server-service"
import * as DataRoot from "@rika/configuration/canonical-data-root"
import { workspacePaths } from "@rika/configuration/configuration-paths"
import { Effect, Layer, Cause, Clock, References, Schema } from "effect"
import * as Logging from "../../diagnostics/diagnostic-file-logging"
import { spawn as spawnServer } from "../../server/process/server-process-spawn"
import { provideLayerScoped } from "./process-layer"
import { loadSettingsFile, failureKind, withClientWorkspace } from "./process-configuration"
import { loadModePreference, resolveModeDefault } from "./mode-preference"

type DispatcherContext = {
  readonly database: string
  readonly globalConfig: string
  readonly serverRuntime: { readonly executable: string; readonly arguments: ReadonlyArray<string> }
  readonly environment: any
  readonly version: string
  readonly clientOwnedInteractiveFunction: any
  readonly setClientModeConfiguration: (configuration: any) => void
}

export const makeDispatcherLayer = (context: DispatcherContext) => {
  const {
    database,
    globalConfig,
    serverRuntime,
    environment,
    version,
    clientOwnedInteractiveFunction,
    setClientModeConfiguration,
  } = context
  const observedProgram = <A, E>(
    role: Logging.ProcessRole,
    dataRoot: string,
    workspace: string,
    program: (defaultMode: string) => Effect.Effect<A, E>,
  ) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((startedAt) =>
        Effect.logInfo("process.started").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const globalSettings = yield* loadSettingsFile(globalConfig)
              const workspaceSettings = yield* loadSettingsFile(workspacePaths(workspace).settings)
              const effectiveConfig = yield* ConfigurationService.effectiveConfiguration().pipe(
                provideLayerScoped(
                  ConfigurationService.memoryConfigurationLayer({
                    global: globalSettings,
                    workspace: workspaceSettings,
                  }),
                ),
              )
              const modeNames = Object.keys(effectiveConfig.settings.modes)
              const rememberedMode = yield* loadModePreference(dataRoot, modeNames)
              const defaultMode = resolveModeDefault(
                workspaceSettings.defaultMode ?? globalSettings.defaultMode,
                rememberedMode,
                effectiveConfig.settings.defaultMode,
              )
              setClientModeConfiguration({
                routes: ModelRouteLabel.modeRouteLabels(effectiveConfig.settings),
                defaultMode,
                ...(rememberedMode === undefined ? {} : { rememberedMode }),
              })
              return yield* program(defaultMode).pipe(
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
  return Layer.effect(
    Operation.Service,
    Effect.gen(function* () {
      const server = yield* ServerService.Service
      return Operation.Service.of({
        run: Effect.fn("Operation.dispatch")((input) => {
          const workspace =
            (input._tag === "Interactive" || input._tag === "Run" || input._tag === "Review") &&
            input.workspace !== undefined
              ? input.workspace
              : process.cwd()
          return DataRoot.canonicalDataRoot(database).pipe(
            Effect.flatMap((dataRoot) =>
              observedProgram("client", dataRoot, workspace, (defaultMode) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    const clientInput = withClientWorkspace(input, process.cwd())
                    const resolvedClientInput =
                      (clientInput._tag === "Interactive" ||
                        clientInput._tag === "Run" ||
                        clientInput._tag === "Review") &&
                      clientInput.mode === undefined
                        ? { ...clientInput, mode: defaultMode }
                        : clientInput
                    let clientKind: ServerHandshake.Handshake["clientKind"]
                    if (resolvedClientInput._tag === "Interactive") clientKind = "interactive"
                    else if (resolvedClientInput._tag === "Run") clientKind = "run"
                    else clientKind = "product"
                    const connected = yield* Effect.result(
                      server
                        .getOrCreate({
                          profile: "default",
                          dataRoot,
                          clientKind,
                          startHost: () =>
                            spawnServer({
                              executable: serverRuntime.executable,
                              arguments: serverRuntime.arguments,
                              environment: {
                                RIKA_INTERNAL_SERVER_HOST: "1",
                                RIKA_INTERNAL_SERVER_PROFILE: "default",
                                RIKA_INTERNAL_SERVER_DATA_ROOT: dataRoot,
                                ...(environment.serverGrace._tag === "None"
                                  ? {}
                                  : { RIKA_INTERNAL_SERVER_GRACE: environment.serverGrace.value }),
                                ...(environment.serverStartupHold._tag === "None"
                                  ? {}
                                  : { RIKA_INTERNAL_SERVER_STARTUP_HOLD: environment.serverStartupHold.value }),
                                ...(environment.testModelResponse._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MODEL_RESPONSE: environment.testModelResponse.value }),
                                ...(environment.testModelScript._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MODEL_SCRIPT: environment.testModelScript.value }),
                                ...(environment.testMediaAnalyzerResponse._tag === "None"
                                  ? {}
                                  : {
                                      RIKA_TEST_MEDIA_ANALYZER_RESPONSE: environment.testMediaAnalyzerResponse.value,
                                    }),
                                ...(environment.testMediaAnalyzerError._tag === "None"
                                  ? {}
                                  : { RIKA_TEST_MEDIA_ANALYZER_ERROR: environment.testMediaAnalyzerError.value }),
                              },
                            }).pipe(Effect.tap(() => Effect.logInfo("server.spawned"))),
                        })
                        .pipe(provideLayerScoped(Layer.merge(BunServices.layer, BunCrypto.layer))),
                    )
                    if (connected._tag === "Success") {
                      const connection = connected.success
                      yield* Effect.logInfo("server.connected")
                      yield* connection
                        .run(resolvedClientInput, {
                          stdout: (text) => Effect.sync(() => process.stdout.write(text)),
                          stderr: (text) => Effect.sync(() => process.stderr.write(text)),
                          ...(resolvedClientInput._tag === "Interactive"
                            ? { interactive: clientOwnedInteractiveFunction }
                            : {}),
                        })
                        .pipe(
                          Effect.mapError((error) =>
                            Schema.is(ProductOperation.OperationUnavailable)(error)
                              ? error
                              : ProductOperation.OperationUnavailable.make({
                                  operation: resolvedClientInput._tag,
                                  message: error.message,
                                }),
                          ),
                          Effect.ensuring(connection.close),
                        )
                      return
                    }
                    return yield* ProductOperation.OperationUnavailable.make({
                      operation: resolvedClientInput._tag,
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
          )
        }),
      })
    }),
  )
}
