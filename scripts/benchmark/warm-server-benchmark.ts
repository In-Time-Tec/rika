import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ServerService from "@rika/product/server-service"
import { Sha256BunLayer } from "@rika/product/server-service-sha256-bun"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { layer as serverLayer } from "../../apps/rika/src/transport/client/server-client-transport"

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
  const server = yield* ServerService.Service
  const connection: ServerService.Connection = yield* server
    .getOrCreate({
      profile: "default",
      dataRoot: dataRoot.value,
      clientKind: "product",
      graceMilliseconds: 3_600_000,
      allowSupersede: false,
    })
    .pipe(Effect.orDie)
  yield* connection.run({ _tag: "Thread", action: "list" })
  yield* connection.close
  return yield* Schema.encodeEffect(WarmOutputJson)({ warmed: true, role: connection.role })
})

const services = Layer.mergeAll(BunServices.layer, BunCrypto.layer, serverLayer, Sha256BunLayer).pipe(Layer.orDie)

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(services), (context) =>
        Effect.provide(
          program.pipe(
            Effect.tap((output) => Effect.log(output)),
            Effect.orDie,
          ),
          context,
        ),
      ),
    ),
  )
