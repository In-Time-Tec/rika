import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Config, Console, Context, Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { apiAccountGatewayLayer } from "./account/api-gateway"
import { AccountGateway } from "./account/gateway"
import { serveWeb } from "./server/bun"

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
    const port = Number.parseInt(yield* Config.string("PORT"), 10)
    if (!Number.isSafeInteger(port) || port <= 0) return yield* Effect.die("PORT must be a positive integer")
    const nodeEnvironment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"))
    const dependencies = {
      production: nodeEnvironment === "production",
      fileSystem: yield* FileSystem.FileSystem,
      accountGateway: yield* AccountGateway,
    }
    yield* serveWeb({ port, dependencies })
    yield* Console.log(`Rika web listening on port ${port}`)
    return yield* Effect.never
  }),
)

BunRuntime.runMain(
  program.pipe(
    provideLayerScoped(
      Layer.merge(BunFileSystem.layer, apiAccountGatewayLayer.pipe(Layer.provide(FetchHttpClient.layer))),
    ),
  ),
)
