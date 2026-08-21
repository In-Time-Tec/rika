import { BunCrypto } from "@effect/platform-bun"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  closePostgresPool,
  makeBetterAuthIdentityRuntime,
  makePostgresCliDeviceDirectory,
  makePostgresIdentityDirectory,
  makePostgresPool,
  makeResendMailSender,
} from "@rika/identity"
import { serveApi } from "./adapters/bun-server"
import { loadApiConfig } from "./api-config"
import { HostedApplication, layer as hostedApplicationLayer } from "./hosted-application"

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
    const loaded = yield* loadApiConfig(Bun.env)
    const { environment, identity: config, executor: executorOptions, providerCredentialKey } = loaded
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
    const application = Context.get(
      yield* Layer.build(
        hostedApplicationLayer({
          database: postgres,
          databaseUrl: config.databaseUrl,
          providerCredentialKey,
          executor: executorOptions,
          workerId: environment.RAILWAY_DEPLOYMENT_ID ?? executorOptions.deploymentId,
        }),
      ),
      HostedApplication,
    )
    yield* serveApi({
      config,
      dependencies: {
        identity,
        directory: makePostgresIdentityDirectory(pool),
        devices: makePostgresCliDeviceDirectory(pool),
        product: application.product,
        threads: application.threads,
        credentials: application.credentials,
        environment: application.environment,
        models: application.models,
        executor: application.executor,
        execution: application.execution.readiness,
        production: config.production,
      },
    })
    yield* Console.log(`Rika API listening on port ${config.port}`)
    return yield* Effect.never
  }),
)

BunRuntime.runMain(program.pipe(provideLayerScoped(Layer.merge(FetchHttpClient.layer, BunCrypto.layer))))
