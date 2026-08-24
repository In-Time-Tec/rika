import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Context, Effect, Layer, Scope } from "effect"
import { exit } from "node:process"
import * as Logging from "../../src/diagnostics/diagnostic-file-logging"

const provideScoped =
  <ROut, E2, RIn>(layer: Layer.Layer<ROut, E2, RIn>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.scopedWith((scope) =>
      Effect.context<RIn | Exclude<R, ROut>>().pipe(
        Effect.flatMap((parent) =>
          Layer.buildWithScope(layer, scope).pipe(
            Effect.flatMap((context) =>
              effect.pipe(
                Effect.provideContext(Context.merge(parent, context)),
                Effect.provideService(Scope.Scope, scope),
              ),
            ),
          ),
        ),
      ),
    )

const program = Effect.gen(function* () {
  const dataRoot = yield* Config.string("RIKA_TEST_LOG_DATA_ROOT")
  return yield* Logging.start.pipe(
    Effect.andThen(Effect.logInfo("logging.hardexit.fixture")),
    Effect.andThen(Effect.sync(() => exit(0))),
    provideScoped(Logging.layer({ dataRoot, role: "server", version: "test" })),
  )
})

BunRuntime.runMain(program.pipe(provideScoped(BunServices.layer)))
