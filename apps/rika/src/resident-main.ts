#!/usr/bin/env bun
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/product/product-operation"
import * as ResidentService from "@rika/product/resident-service"
import { ConfigContract, ConfigService } from "@rika/configuration/configuration-settings"
import { globalPaths, workspacePaths } from "@rika/configuration/configuration-paths"
import { FetchHttpClient } from "effect/unstable/http"
import { Cause, Clock, Config, Context, Effect, FileSystem, Layer, Path, Ref, References, Schema } from "effect"
import { createHash } from "node:crypto"
import * as Logging from "./logging"
import { serve as serveResident } from "./resident-host-transport"
import * as ResidentProcessStartup from "./resident-process-startup"
import { version } from "./version"

const pathService = Effect.runSync(Effect.scoped(Layer.build(Path.layer))).pipe((context) =>
  Context.get(context, Path.Path),
)
const join = pathService.join

const provideLayerScoped =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scopedWith((scope) =>
      Effect.context<RIn | Exclude<R, ROut>>().pipe(
        Effect.flatMap((parent) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.flatMap((context) => effect.pipe(Effect.provideContext(Context.merge(parent, context)))),
          ),
        ),
      ),
    )

const loadSettingsFile = Effect.fn("Resident.loadSettingsFile")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (!(yield* fileSystem.exists(filename))) return {}
  const text = yield* fileSystem
    .readFileString(filename)
    .pipe(Effect.mapError((error) => ConfigContract.ConfigFileError.make({ path: filename, message: String(error) })))
  const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text).pipe(
    Effect.mapError((error) =>
      ConfigContract.ConfigFileError.make({
        path: filename,
        message: `Invalid JSON: ${String(error)}`,
      }),
    ),
  )
  return ConfigContract.decodeSettingsInput(filename, value)
})

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure instanceof Error) return failure.name
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  return typeof failure
}

const start = () => {
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
      recoveryAbandon: Config.option(Config.string("RIKA_INTERNAL_RECOVERY_ABANDON")),
      residentProfile: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_PROFILE")),
      residentGrace: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_GRACE")),
      residentStartupHold: Config.option(Config.string("RIKA_INTERNAL_RESIDENT_STARTUP_HOLD")),
    }),
  )
  const hostDataRoot = environment.hostDataRoot._tag === "Some" ? environment.hostDataRoot.value : undefined
  const home = environment.home._tag === "Some" ? environment.home.value : process.cwd()
  const defaultDataRoot = `${home}/.rika`
  let database: string
  let executionDatabase: string
  if (hostDataRoot === undefined) {
    database = environment.database._tag === "Some" ? environment.database.value : `${defaultDataRoot}/rika.db`
    executionDatabase =
      environment.executionDatabase._tag === "Some"
        ? environment.executionDatabase.value
        : `${defaultDataRoot}/execution.db`
  } else {
    database = join(hostDataRoot, "rika.db")
    executionDatabase = join(hostDataRoot, "execution.db")
  }
  const globalLayout = globalPaths(home)
  const workspaceLayout = workspacePaths(process.cwd())
  const globalConfig = globalLayout.settings
  const workspaceConfig = workspaceLayout.settings
  const profile = environment.residentProfile._tag === "Some" ? environment.residentProfile.value : "default"
  const profileIdentity = createHash("sha256").update(profile).digest("hex")
  let editor: string | undefined
  if (environment.visual._tag === "Some") editor = environment.visual.value
  else if (environment.editor._tag === "Some") editor = environment.editor.value
  const productOptions = {
    environment: {
      testModelResponse: environment.testModelResponse,
      testModelScript: environment.testModelScript,
      recoveryAbandon: environment.recoveryAbandon,
    },
    database,
    executionDatabase,
    globalConfig,
    workspaceConfig,
    editor,
    home,
    workspaceRoot: process.cwd(),
  }
  const authOptions = { globalConfig, database, profileIdentity }
  const residentOwner: ResidentService.Owner = (interactive) =>
    Effect.scope.pipe(
      Effect.flatMap((scope) =>
        Effect.gen(function* () {
          const productLoaded = yield* Ref.make(false)
          const loadProduct: Effect.Effect<Operation.Interface, Operation.OperationUnavailable, never> =
            yield* Effect.cached(
              Clock.currentTimeMillis
                .pipe(
                  Effect.flatMap((startedAt) =>
                    Effect.gen(function* () {
                      const product = yield* Effect.tryPromise({
                        try: () => import("./resident-product"),
                        catch: (cause) =>
                          Operation.OperationUnavailable.make({
                            operation: "ResidentProduct",
                            message: String(cause),
                          }),
                      })
                      const authOperations = product.createAuthOperations(authOptions)
                      return yield* Layer.buildWithScope(
                        product
                          .createOperationLayer({ ...productOptions, authOperations }, interactive)
                          .pipe(
                            Layer.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
                          ),
                        scope,
                      )
                        .pipe(
                          Effect.map((context) => Context.get(context, Operation.Service)),
                          Effect.tap(() => Ref.set(productLoaded, true)),
                          Effect.tap(() =>
                            Clock.currentTimeMillis.pipe(
                              Effect.flatMap((completedAt) =>
                                Effect.logInfo("resident.product.loaded").pipe(
                                  Effect.annotateLogs("rika.duration.ms", completedAt - startedAt),
                                ),
                              ),
                            ),
                          ),
                        )
                        .pipe(
                          Effect.mapError((error) =>
                            Schema.is(Operation.OperationUnavailable)(error)
                              ? error
                              : Operation.OperationUnavailable.make({
                                  operation: "ResidentProduct",
                                  message: String(error),
                                }),
                          ),
                        )
                    }),
                  ),
                )
                .pipe(Effect.provide(BunServices.layer)),
            )
          return Operation.Service.of({
            hasActiveExecutionWork: Ref.get(productLoaded).pipe(
              Effect.flatMap((loaded) =>
                loaded
                  ? loadProduct.pipe(
                      Effect.flatMap((service) => service.hasActiveExecutionWork ?? Effect.succeed(true)),
                    )
                  : Effect.succeed(false),
              ),
              Effect.mapError((error) =>
                Schema.is(Operation.OperationUnavailable)(error)
                  ? error
                  : Operation.OperationUnavailable.make({
                      operation: "ResidentReplacement",
                      message: String(error),
                    }),
              ),
            ),
            authorizeResidentReplacement: loadProduct.pipe(
              Effect.flatMap((service) => service.authorizeResidentReplacement ?? Effect.succeed("defer" as const)),
              Effect.mapError((error) =>
                Schema.is(Operation.OperationUnavailable)(error)
                  ? error
                  : Operation.OperationUnavailable.make({
                      operation: "ResidentReplacement",
                      message: String(error),
                    }),
              ),
            ),
            stopActiveExecutionWork: Ref.get(productLoaded).pipe(
              Effect.flatMap((loaded) =>
                loaded
                  ? loadProduct.pipe(Effect.flatMap((service) => service.stopActiveExecutionWork ?? Effect.void))
                  : Effect.void,
              ),
              Effect.mapError((error) =>
                Schema.is(Operation.OperationUnavailable)(error)
                  ? error
                  : Operation.OperationUnavailable.make({
                      operation: "ResidentAbandonment",
                      message: String(error),
                    }),
              ),
            ),
            run: (input) => {
              if (input._tag === "Auth") {
                return Effect.gen(function* () {
                  const product = yield* Effect.tryPromise({
                    try: () => import("./resident-product"),
                    catch: (cause) =>
                      Operation.OperationUnavailable.make({
                        operation: "Auth",
                        message: String(cause),
                      }),
                  })
                  return yield* Effect.scoped(product.runResidentAuth(input, authOptions, process.cwd()))
                }).pipe(
                  Effect.mapError((error) =>
                    Schema.is(Operation.OperationUnavailable)(error)
                      ? error
                      : Operation.OperationUnavailable.make({
                          operation: "Auth",
                          message: String(error),
                        }),
                  ),
                )
              }
              return loadProduct.pipe(
                Effect.flatMap((service) => service.run(input)),
                Effect.mapError((error) =>
                  Schema.is(Operation.OperationUnavailable)(error)
                    ? error
                    : Operation.OperationUnavailable.make({
                        operation: input._tag,
                        message: String(error),
                      }),
                ),
              )
            },
          })
        }),
      ),
    )
  const observedProgram = <A, E>(role: Logging.ProcessRole, dataRoot: string, program: Effect.Effect<A, E>) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((startedAt) =>
        Effect.logInfo("process.started").pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const globalSettings = yield* loadSettingsFile(globalConfig)
              const workspaceSettings = yield* loadSettingsFile(workspaceConfig)
              const effectiveConfig = yield* ConfigService.effective().pipe(
                provideLayerScoped(
                  ConfigService.memoryLayer({
                    global: globalSettings,
                    workspace: workspaceSettings,
                  }),
                ),
              )
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
  const hostProgram =
    hostDataRoot === undefined
      ? Effect.die("Resident host data root is unavailable")
      : Effect.scoped(
          serveResident({
            profile: environment.residentProfile._tag === "Some" ? environment.residentProfile.value : "default",
            dataRoot: hostDataRoot,
            graceMilliseconds: Number(
              environment.residentGrace._tag === "Some" ? environment.residentGrace.value : "900000",
            ),
            startupHoldMilliseconds: Number(
              environment.residentStartupHold._tag === "Some" ? environment.residentStartupHold.value : "10000",
            ),
            onReady: ResidentProcessStartup.signalReady,
            owner: residentOwner,
          }),
        ).pipe(
          Effect.tapCause((cause) => {
            const failure = Cause.squash(cause)
            const message =
              failure !== null && typeof failure === "object" && "message" in failure
                ? String(failure.message)
                : String(failure)
            return ResidentProcessStartup.signalFailure(message).pipe(Effect.ignore)
          }),
          provideLayerScoped(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
        )
  BunRuntime.runMain(observedProgram("resident", hostDataRoot ?? defaultDataRoot, hostProgram))
}

if (import.meta.main) start()
