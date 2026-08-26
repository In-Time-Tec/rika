import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Context, Effect, FileSystem, Layer, Scope } from "effect"
import * as Logging from "../../src/diagnostics/file-logging"

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
  const secret = yield* Config.string("RIKA_TEST_ARBITRARY_VALUE")
  const fs = yield* FileSystem.FileSystem
  yield* fs.writeFileString(`${dataRoot}/first-draw.boundary`, "drawn")
  while (!(yield* fs.exists(`${dataRoot}/logging.release`))) {
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.gen(function* () {
    yield* Logging.start
    yield* Effect.logInfo("logging.signal.fixture").pipe(Effect.annotateLogs("rika.fixture.arbitrary", secret))
    yield* fs.writeFileString(`${dataRoot}/logging.ready`, "ready")
    return yield* Effect.never
  }).pipe(provideScoped(Logging.layer({ dataRoot, role: "client", version: "test" })))
})

BunRuntime.runMain(program.pipe(provideScoped(BunServices.layer)))
