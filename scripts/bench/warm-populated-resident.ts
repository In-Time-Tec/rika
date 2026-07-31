import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as ResidentService from "@rika/app/resident-service"
import { Effect, Layer } from "effect"
import { layer as residentLayer } from "../../apps/rika/src/resident-client-transport"

const dataRoot = process.env.RIKA_WARM_ROOT
if (dataRoot === undefined || dataRoot.length === 0) {
  console.error("RIKA_WARM_ROOT is required")
  process.exit(1)
}

const program = Effect.gen(function* () {
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
  yield* Effect.sync(() => console.log(JSON.stringify({ warmed: true, role: connection.role })))
})

await Effect.runPromise(
  program.pipe(Effect.provide(Layer.mergeAll(BunServices.layer, BunCrypto.layer, residentLayer)), Effect.scoped),
)
