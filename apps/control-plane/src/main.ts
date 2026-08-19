import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import {
  closePostgresPool,
  loadIdentityConfig,
  makeBetterAuthIdentityRuntime,
  makePostgresIdentityDirectory,
  makePostgresPool,
  makeResendMailSender,
} from "@rika/identity"
import { serveControlPlane } from "./adapters/bun-server"

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
    yield* serveControlPlane({
      config,
      dependencies: {
        identity,
        directory: makePostgresIdentityDirectory(pool),
        production: config.production,
      },
    })
    yield* Console.log(`Rika control plane listening on port ${config.port}`)
    return yield* Effect.never
  }),
)

BunRuntime.runMain(program.pipe(provideLayerScoped(FetchHttpClient.layer)))
