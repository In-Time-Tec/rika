import * as BunServices from "@effect/platform-bun/BunServices"
import { CellExecutor, layer } from "@rika/kernel/cell-executor"
import { Context, Effect, Layer } from "effect"

const program = Effect.scoped(
  Effect.gen(function* () {
    const context = yield* Layer.build(
      layer({
        workspace: "/workspace",
        workspaceDigest: "doctor",
        dataRoot: "/var/lib/rika-executor",
        runtimeVersion: process.versions.bun,
        trustMode: "trusted-local",
        servers: [],
      }).pipe(Layer.provide(BunServices.layer)),
    )
    const executor = Context.get(context, CellExecutor)
    const first = yield* executor.execute({ sessionId: "doctor", cellId: "1", code: "let value: number = 41; value" })
    const second = yield* executor.execute({ sessionId: "doctor", cellId: "2", code: "value += 1; value" })
    if (
      first._tag !== "Success" ||
      first.result.value !== "41" ||
      second._tag !== "Success" ||
      second.result.value !== "42"
    )
      return yield* Effect.die("kernel persistence check failed")
    console.log("41,42")
  }),
)

await Effect.runPromise(program)
