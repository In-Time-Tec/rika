import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import { Console, Context, Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { makeApiAccountGateway } from "./adapters/api-account-gateway"
import { serveWeb } from "./adapters/bun-server"

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

const required = (name: "API_DOMAIN" | "API_PORT" | "PORT") => {
  const value = Bun.env[name]
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`)
  return value
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const port = Number.parseInt(required("PORT"), 10)
    if (!Number.isSafeInteger(port) || port <= 0) return yield* Effect.die("PORT must be a positive integer")
    const dependencies = {
      production: Bun.env.NODE_ENV === "production",
      accountGateway: makeApiAccountGateway({
        domain: required("API_DOMAIN"),
        port: required("API_PORT"),
        client: yield* HttpClient.HttpClient,
      }),
    }
    yield* serveWeb({ port, dependencies })
    yield* Console.log(`Rika web listening on port ${port}`)
    return yield* Effect.never
  }),
)

BunRuntime.runMain(program.pipe(provideLayerScoped(FetchHttpClient.layer)))
