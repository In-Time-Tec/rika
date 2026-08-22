import * as ProductOperation from "@rika/product/product-operation"
import * as ConfigurationService from "@rika/configuration/configuration-service"
import * as SettingsDecoder from "@rika/configuration/configuration-settings"
import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Operation from "@rika/product/product-operation-service"
import * as ServerService from "@rika/product/server-service"
import { globalPaths, workspacePaths } from "@rika/configuration/configuration-paths"
import { resolveProfileDataPaths } from "@rika/configuration/profile-data-paths"
import { FetchHttpClient } from "effect/unstable/http"
import {
  Cause,
  Clock,
  Config,
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  References,
  Schema,
  Scope,
} from "effect"
import { createHash } from "node:crypto"
import * as Logging from "../../diagnostics/diagnostic-file-logging"
import { serve as serveServer } from "../../transport/host/server-host-transport"
import { version } from "../../platform/application-version"

export { spawn } from "./server-process-spawn"

const StartupMessage = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("ready") }),
  Schema.Struct({ _tag: Schema.tag("failed"), message: Schema.String }),
])

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const startupFdEnvironment = "RIKA_INTERNAL_SERVER_STARTUP_FD"
let signalled = false
const closeDescriptor = (descriptor: number) =>
  Effect.sync(() => process.getBuiltinModule("node:fs").closeSync(descriptor))
const writeDescriptor = (descriptor: number, value: string) =>
  Effect.try(() => process.getBuiltinModule("node:fs").writeFileSync(descriptor, value))

const startupError = (reason: "startup-failed" | "transport-failed", cause: unknown) =>
  ServerService.ServerServiceError.make({ reason, message: String(cause) })

const signal = (message: typeof StartupMessage.Type) =>
  Effect.gen(function* () {
    const configured = yield* Config.option(Config.string(startupFdEnvironment))
    if (Option.isNone(configured) || signalled) return
    signalled = true
    const descriptor = Number(configured.value)
    yield* writeDescriptor(descriptor, `${encode(message)}\n`).pipe(Effect.ensuring(closeDescriptor(descriptor)))
  }).pipe(
    Effect.mapError((cause) => startupError("startup-failed", `Could not report server startup: ${String(cause)}`)),
  )

export const signalReady = signal({ _tag: "ready" })
export const signalFailure = (message: string) => signal({ _tag: "failed", message })

type Owner = (
  interactive: (
    input: import("@rika/product/server-interactive-feed").InteractiveInput,
    session: import("@rika/product/interactive-session").InteractiveSession,
  ) => Effect.Effect<void, ProductOperation.OperationUnavailable>,
) => Effect.Effect<Operation.Interface, ServerService.ServerServiceError, import("effect").Scope.Scope>

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

const loadSettingsFile = Effect.fn("Server.loadSettingsFile")(function* (filename: string) {
  const fileSystem = yield* FileSystem.FileSystem
  if (!(yield* fileSystem.exists(filename))) return {}
  const text = yield* fileSystem
    .readFileString(filename)
    .pipe(
      Effect.mapError((error) =>
        SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({ path: filename, message: String(error) }),
      ),
    )
  const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
    Effect.mapError((error) =>
      SettingsDecoder.Decoder.ConfigurationSettingsFileError.make({
        path: filename,
        message: `Invalid JSON: ${String(error)}`,
      }),
    ),
  )
  return SettingsDecoder.Decoder.decodeSettingsInput(filename, value)
})

const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure instanceof Error) return failure.name
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  return typeof failure
}

export const start = () => {
  const environment = Effect.runSync(
    Config.all({
      hostDataRoot: Config.option(Config.string("RIKA_INTERNAL_SERVER_DATA_ROOT")),
      home: Config.option(Config.string("HOME")),
      database: Config.option(Config.string("RIKA_DATABASE")),
      tenetkitDatabase: Config.option(Config.string("RIKA_TENETKIT_DATABASE")),
      visual: Config.option(Config.string("VISUAL")),
      editor: Config.option(Config.string("EDITOR")),
      testModelResponse: Config.option(Config.string("RIKA_TEST_MODEL_RESPONSE")),
      testModelScript: Config.option(Config.string("RIKA_TEST_MODEL_SCRIPT")),
      recoveryAbandon: Config.option(Config.string("RIKA_INTERNAL_RECOVERY_ABANDON")),
      serverProfile: Config.option(Config.string("RIKA_INTERNAL_SERVER_PROFILE")),
      serverGrace: Config.option(Config.string("RIKA_INTERNAL_SERVER_GRACE")),
      serverStartupHold: Config.option(Config.string("RIKA_INTERNAL_SERVER_STARTUP_HOLD")),
      configReloadDebounce: Config.option(Config.string("RIKA_INTERNAL_SERVER_CONFIG_RELOAD_DEBOUNCE")),
      configReloadDrainTimeout: Config.option(Config.string("RIKA_INTERNAL_SERVER_CONFIG_RELOAD_DRAIN_TIMEOUT")),
    }),
  )
  const hostDataRoot = environment.hostDataRoot._tag === "Some" ? environment.hostDataRoot.value : undefined
  const home = environment.home._tag === "Some" ? environment.home.value : process.cwd()
  const paths = resolveProfileDataPaths({
    home,
    hostDataRoot,
    productDatabase: environment.database._tag === "Some" ? environment.database.value : undefined,
    tenetkitDatabase: environment.tenetkitDatabase._tag === "Some" ? environment.tenetkitDatabase.value : undefined,
  })
  const database = paths.database
  const globalLayout = globalPaths(home)
  const workspaceLayout = workspacePaths(process.cwd())
  const globalConfig = globalLayout.settings
  const workspaceConfig = workspaceLayout.settings
  const profile = environment.serverProfile._tag === "Some" ? environment.serverProfile.value : "default"
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
    tenetkitDatabase: paths.tenetkitDatabase,
    profileIdentity,
    globalConfig,
    workspaceConfig,
    editor,
    home,
    workspaceRoot: process.cwd(),
  }
  const authOptions = { globalConfig, database, profileIdentity }
  const serverOwner: Owner = (interactive) =>
    Effect.scope.pipe(
      Effect.flatMap((scope) =>
        Effect.gen(function* () {
          const productLoaded = yield* Ref.make(false)
          const bunServices = yield* Layer.buildWithScope(BunServices.layer, scope)
          const acquireProduct = Clock.currentTimeMillis.pipe(
            Effect.flatMap((startedAt) =>
              Effect.gen(function* () {
                const product = yield* Effect.tryPromise({
                  try: () => import("../composition/server-product-layer"),
                  catch: (cause) =>
                    ProductOperation.OperationUnavailable.make({
                      operation: "ServerProduct",
                      message: String(cause),
                    }),
                })
                const auth = yield* Effect.tryPromise({
                  try: () => import("../composition/server-auth-layer"),
                  catch: (cause) =>
                    ProductOperation.OperationUnavailable.make({ operation: "Auth", message: String(cause) }),
                })
                const authOperations = auth.createAuthOperations(authOptions)
                return yield* Layer.buildWithScope(
                  product
                    .createOperationLayer({ ...productOptions, authOperations }, interactive)
                    .pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          BunServices.layer,
                          BunCrypto.layer,
                          FetchHttpClient.layer,
                          Layer.succeed(Scope.Scope, scope),
                        ),
                      ),
                    ),
                  scope,
                ).pipe(
                  Effect.map((context) => Context.get(context, Operation.Service)),
                  Effect.tap(() => Ref.set(productLoaded, true)),
                  Effect.tap(() =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((completedAt) =>
                        Effect.logInfo("server.product.loaded").pipe(
                          Effect.annotateLogs("rika.duration.ms", completedAt - startedAt),
                        ),
                      ),
                    ),
                  ),
                  Effect.mapError((error) =>
                    Schema.is(ProductOperation.OperationUnavailable)(error)
                      ? error
                      : ProductOperation.OperationUnavailable.make({
                          operation: "ServerProduct",
                          message: String(error),
                        }),
                  ),
                )
              }),
            ),
            Effect.provideContext(bunServices),
          )
          const loadProductEffect: Effect.Effect<Operation.Interface, ProductOperation.OperationUnavailable, never> =
            acquireProduct
          const loadProduct = yield* Effect.cached(loadProductEffect)
          yield* loadProduct.pipe(Effect.mapError((error) => startupError("startup-failed", error)))
          return Operation.Service.of({
            prepareServerReplacement: loadProduct.pipe(
              Effect.flatMap((service) => service.prepareServerReplacement ?? Effect.void),
              Effect.orDie,
            ),
            stopActiveExecutionWork: Ref.get(productLoaded).pipe(
              Effect.flatMap((loaded) =>
                loaded
                  ? loadProduct.pipe(Effect.flatMap((service) => service.stopActiveExecutionWork ?? Effect.void))
                  : Effect.void,
              ),
              Effect.mapError((error) =>
                Schema.is(ProductOperation.OperationUnavailable)(error)
                  ? error
                  : ProductOperation.OperationUnavailable.make({
                      operation: "ServerAbandonment",
                      message: String(error),
                    }),
              ),
            ),
            run: (input) => {
              if (input._tag === "Auth") {
                return Effect.scoped(
                  Effect.tryPromise({
                    try: () => import("../composition/server-auth-layer"),
                    catch: (cause) =>
                      ProductOperation.OperationUnavailable.make({ operation: "Auth", message: String(cause) }),
                  }).pipe(Effect.flatMap((auth) => auth.runServerAuth(input, authOptions, process.cwd()))),
                ).pipe(
                  Effect.mapError((error) =>
                    Schema.is(ProductOperation.OperationUnavailable)(error)
                      ? error
                      : ProductOperation.OperationUnavailable.make({
                          operation: "Auth",
                          message: String(error),
                        }),
                  ),
                  Effect.provideContext(bunServices),
                  Effect.provideService(Scope.Scope, scope),
                )
              }
              return loadProduct.pipe(
                Effect.flatMap((service) => service.run(input)),
                Effect.mapError((error) =>
                  Schema.is(ProductOperation.OperationUnavailable)(error)
                    ? error
                    : ProductOperation.OperationUnavailable.make({
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
              const effectiveConfig = yield* ConfigurationService.effectiveConfiguration().pipe(
                provideLayerScoped(
                  ConfigurationService.memoryConfigurationLayer({
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
      ? Effect.die("Server process data root is unavailable")
      : Effect.scoped(
          serveServer({
            profile: environment.serverProfile._tag === "Some" ? environment.serverProfile.value : "default",
            dataRoot: hostDataRoot,
            graceMilliseconds: Number(
              environment.serverGrace._tag === "Some" ? environment.serverGrace.value : "900000",
            ),
            startupHoldMilliseconds: Number(
              environment.serverStartupHold._tag === "Some" ? environment.serverStartupHold.value : "10000",
            ),
            configWatchPaths: [globalConfig, workspaceConfig],
            configReloadDebounceMilliseconds: Number(
              environment.configReloadDebounce._tag === "Some" ? environment.configReloadDebounce.value : "1000",
            ),
            configReloadDrainTimeoutMilliseconds: Number(
              environment.configReloadDrainTimeout._tag === "Some"
                ? environment.configReloadDrainTimeout.value
                : "30000",
            ),
            onReady: signalReady,
            owner: serverOwner,
          }),
        ).pipe(
          Effect.tapCause((cause) => {
            const failure = Cause.squash(cause)
            const message =
              failure !== null && typeof failure === "object" && "message" in failure
                ? String(failure.message)
                : String(failure)
            return signalFailure(message).pipe(Effect.ignore)
          }),
          provideLayerScoped(Layer.mergeAll(BunServices.layer, BunCrypto.layer, FetchHttpClient.layer)),
        )
  const removeSigintIsolation = installServerSigintIsolation()
  const fiber = Effect.runFork(observedProgram("server", paths.dataRoot, hostProgram))
  const terminate = () => fiber.interruptUnsafe()
  process.on("SIGTERM", terminate)
  fiber.addObserver((exit) => {
    removeSigintIsolation()
    ;(process as NodeJS.EventEmitter).off("SIGTERM", terminate)
    process.exit(exit._tag === "Success" ? 0 : 1)
  })
}

const isolateSigint = () => {}

export const installServerSigintIsolation = (): (() => void) => {
  process.on("SIGINT", isolateSigint)
  return () => (process as NodeJS.EventEmitter).off("SIGINT", isolateSigint)
}
