import * as ModelRouteLabel from "@rika/config/model-route-label"
import * as ConfigurationService from "@rika/config/configuration-service"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/product/product-operation-service"
import * as ProductOperation from "@rika/product/product-operation"
import * as ServerHandshake from "@rika/product/server-service-handshake"
import * as ServerService from "@rika/product/server-service"
import * as DataRoot from "@rika/config/canonical-data-root"
import { Effect, Layer, Cause, Clock, References, Schema } from "effect"
import * as Logging from "../../diagnostics/diagnostic-file-logging"
import * as ServerProcessStartup from "../../server/process/server-process"
import { spawn as spawnServer } from "../../server/process/server-process-spawn"
import { provideLayerScoped } from "./process-layer"
import { loadSettingsFile, failureKind, withClientWorkspace } from "./process-configuration"

type DispatcherContext = {
  readonly database: string
  readonly globalConfig: string
  readonly workspaceConfig: string
  readonly serverRuntime: { readonly executable: string; readonly arguments: ReadonlyArray<string> }
  readonly environment: any
  readonly restartThreadId: string | undefined
  readonly runtimeRestarted: boolean
  readonly version: string
  readonly clientOwnedInteractiveFunction: any
  readonly setClientModeRoutes: (routes: any) => void
  readonly runtimeRestartRequest: { value: { readonly threadId?: string } | undefined }
}

export const makeDispatcherLayer = (context: DispatcherContext) => {
  const {
    database,
    globalConfig,
    workspaceConfig,
    serverRuntime,
    environment,
    restartThreadId,
    runtimeRestarted,
    version,
    clientOwnedInteractiveFunction,
    setClientModeRoutes,
    runtimeRestartRequest,
  } = context
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
              setClientModeRoutes(ModelRouteLabel.modeRouteLabels(effectiveConfig.settings))
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
  return Layer.effect(
    Operation.Service,
    Effect.gen(function* () {
      const server = yield* ServerService.Service
      return Operation.Service.of({
        run: Effect.fn("Operation.dispatch")((input) =>
          DataRoot.canonicalDataRoot(database).pipe(
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
                    const requestRuntimeRestart = (error: ServerService.ServerRestartRequired) =>
                      Effect.sync(() => {
                        runtimeRestartRequest.value = error.threadId === undefined ? {} : { threadId: error.threadId }
                      }).pipe(
                        Effect.andThen(
                          ServerProcessStartup.runtimeRestart.signalRuntimeRestart(error.threadId).pipe(Effect.ignore),
                        ),
                        Effect.andThen(
                          ProductOperation.OperationUnavailable.make({
                            operation: clientInput._tag,
                            message: "Rika was upgraded; restarting this session",
                          }),
                        ),
                      )
                    let clientKind: ServerHandshake.Handshake["clientKind"]
                    if (clientInput._tag === "Interactive") clientKind = "interactive"
                    else if (clientInput._tag === "Run") clientKind = "run"
                    else clientKind = "product"
                    const connected = yield* Effect.result(
                      server
                        .getOrCreate({
                          profile: "default",
                          dataRoot,
                          ...(runtimeRestarted ? { allowSupersede: false } : {}),
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
                                  : { RIKA_TEST_MEDIA_ANALYZER_RESPONSE: environment.testMediaAnalyzerResponse.value }),
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
                        .run(clientInput, {
                          stdout: (text) => Effect.sync(() => process.stdout.write(text)),
                          stderr: (text) => Effect.sync(() => process.stderr.write(text)),
                          ...(clientInput._tag === "Interactive"
                            ? { interactive: clientOwnedInteractiveFunction }
                            : {}),
                        })
                        .pipe(
                          Effect.tapError((error) =>
                            Schema.is(ServerService.ServerRestartRequired)(error)
                              ? Effect.sync(() => {
                                  runtimeRestartRequest.value =
                                    error.threadId === undefined ? {} : { threadId: error.threadId }
                                }).pipe(
                                  Effect.andThen(
                                    ServerProcessStartup.runtimeRestart
                                      .signalRuntimeRestart(error.threadId)
                                      .pipe(Effect.ignore),
                                  ),
                                )
                              : Effect.void,
                          ),
                          Effect.mapError((error) =>
                            Schema.is(ProductOperation.OperationUnavailable)(error)
                              ? error
                              : ProductOperation.OperationUnavailable.make({
                                  operation: clientInput._tag,
                                  message: Schema.is(ServerService.ServerRestartRequired)(error)
                                    ? "Rika was upgraded; restarting this session"
                                    : error.message,
                                }),
                          ),
                          Effect.ensuring(connection.close),
                        )
                      return
                    }
                    if (Schema.is(ServerService.ServerRestartRequired)(connected.failure))
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
}
