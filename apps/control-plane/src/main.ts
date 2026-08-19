import { BunCrypto } from "@effect/platform-bun"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Context, Effect, Layer } from "effect"
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
import { serveControlPlane } from "./adapters/bun-server"
import { HostedProduct, postgres as hostedProductPostgres } from "./hosted-product"

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
    const config = yield* loadIdentityConfig(Bun.env)
    const httpClient = yield* HttpClient.HttpClient
    const pool = makePostgresPool(config)
    yield* Effect.addFinalizer(() => closePostgresPool(pool).pipe(Effect.ignore))
    const identity = makeBetterAuthIdentityRuntime({
      config,
      pool,
      mail: makeResendMailSender({ config, client: httpClient }),
    })
    const product = yield* Layer.build(
      hostedProductPostgres({
        url: config.databaseUrl,
        ssl: config.databaseSsl === "disable" ? false : { rejectUnauthorized: config.databaseSsl === "verify-full" },
        maxConnections: 10,
      }),
    )
    yield* serveControlPlane({
      config,
      dependencies: {
        identity,
        directory: makePostgresIdentityDirectory(pool),
        devices: makePostgresCliDeviceDirectory(pool),
        product: Context.get(product, HostedProduct),
        production: config.production,
      },
    })
    yield* Console.log(`Rika control plane listening on port ${config.port}`)
    return yield* Effect.never
  }),
)

BunRuntime.runMain(program.pipe(provideLayerScoped(Layer.merge(FetchHttpClient.layer, BunCrypto.layer))))
