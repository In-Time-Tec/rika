import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, Layer, Schema } from "effect"
import { layer as residentLayer } from "../../apps/rika/src/resident-client-transport"
import * as ResidentService from "../../packages/app/src/resident-service"

const program = Effect.gen(function* () {
  const dataRoot = yield* Config.nonEmptyString("RIKA_WARM_ROOT")
  const services = Layer.mergeAll(BunServices.layer, BunCrypto.layer, residentLayer)
  const context = yield* Layer.build(services)
  yield* Effect.gen(function* () {
    const resident = yield* ResidentService.Service
    const connection = yield* resident.getOrCreate({
      profile: "default",
      dataRoot,
      clientKind: "product",
      graceMilliseconds: 3_600_000,
      allowSupersede: false,
    })
    yield* connection.run({ _tag: "Thread", action: "list" })
    yield* connection.close
    const encoded = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({ warmed: true, role: connection.role })
    yield* Effect.logInfo(encoded)
  }).pipe(Effect.provide(context))
})

if (import.meta.main) BunRuntime.runMain(Effect.scoped(program))
