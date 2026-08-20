import { BunCrypto } from "@effect/platform-bun"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Context, Effect, Layer, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  closePostgresPool,
  loadIdentityConfig,
  makeBetterAuthIdentityRuntime,
  makePostgresCliDeviceDirectory,
  makePostgresIdentityDirectory,
  makePostgresPool,
  makeResendMailSender,
} from "@rika/identity"
import { layer as postgresLayer } from "@rika/product-store/postgres-layer"
import * as HostedExecution from "@rika/execution"
import * as ExecutionPostgres from "@rika/execution/postgres"
import * as RemoteCells from "@rika/execution/remote-cells"
import { serveApi } from "./adapters/bun-server"
import { config as executorConfig, Executor, layer as executorLayer, service as executorService } from "./executor"
import { HostedProduct, postgres as hostedProductPostgres } from "./hosted-product"
import { runtimeEnvironment } from "./runtime-environment"

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

const program = Effect.scoped(
  Effect.gen(function* () {
    const environment = runtimeEnvironment(Bun.env)
    const config = yield* loadIdentityConfig(environment)
    const httpClient = yield* HttpClient.HttpClient
    const pool = makePostgresPool(config)
    yield* Effect.addFinalizer(() => closePostgresPool(pool).pipe(Effect.ignore))
    const identity = makeBetterAuthIdentityRuntime({
      config,
      pool,
      mail: makeResendMailSender({ config, client: httpClient }),
    })
    const postgres = {
      url: config.databaseUrl,
      ssl: config.databaseSsl === "disable" ? false : { rejectUnauthorized: config.databaseSsl === "verify-full" },
      maxConnections: 10,
    }
    const executorOptions = executorConfig(environment)
    const product = Context.get(
      yield* Layer.build(
        hostedProductPostgres({
          database: postgres,
          templateBuildId: executorOptions.templateBuildId,
          providerScope: executorOptions.deploymentId,
        }),
      ),
      HostedProduct,
    )
    const executor = Context.get(
      yield* Layer.build(
        executorService.pipe(
          Layer.provide(executorLayer(executorOptions)),
          Layer.provide(postgresLayer(postgres)),
          Layer.provide(BunCrypto.layer),
        ),
      ),
      Executor,
    )
    const execution = Context.get(
      yield* Layer.build(
        HostedExecution.layerHosted({
          kernel: { runtimeVersion: Bun.version, dataRoot: "/workspace" },
          cells: HostedExecution.remoteCells({
            cells: RemoteCells.layer({
              execute: (request) =>
                executor
                  .run({ threadId: request.sessionId, operationKey: request.operationKey, code: request.code })
                  .pipe(
                    Effect.map((result) => result.response),
                    Effect.mapError((error) => RemoteCells.Unavailable.make({ message: error.message })),
                  ),
            }),
            maxRetries: 3,
            retryDelayMillis: 250,
          }),
          postgres: {
            url: Redacted.value(config.databaseUrl),
            source: "rika-api",
            maxConnections: postgres.maxConnections,
            worker: {
              workerId: Bun.env.RAILWAY_DEPLOYMENT_ID ?? executorOptions.deploymentId,
              concurrency: 8,
              leaseMillis: 30_000,
              pollIntervalMillis: 250,
              cancellationIntervalMillis: 1_000,
            },
          },
        }),
      ),
      ExecutionPostgres.Readiness,
    )
    yield* serveApi({
      config,
      dependencies: {
        identity,
        directory: makePostgresIdentityDirectory(pool),
        devices: makePostgresCliDeviceDirectory(pool),
        product,
        executor,
        execution,
        production: config.production,
      },
    })
    yield* Console.log(`Rika API listening on port ${config.port}`)
    return yield* Effect.never
  }),
)

BunRuntime.runMain(program.pipe(provideLayerScoped(Layer.merge(FetchHttpClient.layer, BunCrypto.layer))))
