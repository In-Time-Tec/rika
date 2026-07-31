import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ResidentService from "../../packages/product/src/resident-service"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { layer as residentLayer } from "../../apps/rika/src/resident-client-transport"

class WarmConfigurationError extends Schema.TaggedErrorClass<WarmConfigurationError>()("WarmConfigurationError", {
  message: Schema.String,
}) {}

const WarmOutputJson = Schema.fromJsonString(
  Schema.Struct({
    warmed: Schema.Literal(true),
    role: Schema.String,
  }),
)

const root = Config.option(Config.string("RIKA_WARM_ROOT"))
const program = Effect.gen(function* () {
  const dataRoot = yield* root
  if (Option.isNone(dataRoot) || dataRoot.value.length === 0)
    return yield* WarmConfigurationError.make({ message: "RIKA_WARM_ROOT is required" })
  const resident = yield* ResidentService.Service
  const connection = yield* resident.getOrCreate({
    profile: "default",
    dataRoot: dataRoot.value,
    clientKind: "product",
    graceMilliseconds: 3_600_000,
    allowSupersede: false,
  })
  yield* connection.run({ _tag: "Thread", action: "list" })
  yield* connection.close
  return yield* Schema.encodeEffect(WarmOutputJson)({ warmed: true, role: connection.role })
})

const services = Layer.mergeAll(BunServices.layer, BunCrypto.layer, residentLayer)

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(services), (context) =>
        Effect.provide(program.pipe(Effect.tap((output) => Effect.log(output))), context),
      ),
    ),
  )
