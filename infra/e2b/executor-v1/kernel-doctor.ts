import * as BunServices from "@effect/platform-bun/BunServices"
import { CellExecutor, layer } from "@rika/kernel/cell-executor"
import { HostBindingRegistry } from "tenetkit/repl"
import { Context, Effect, Layer } from "effect"

const workspace = process.argv[2] ?? "/home/rika-workspace/workspace/repo"
const dataRoot = process.argv[3] ?? "/var/lib/rika-executor"

const program = Effect.scoped(
  Effect.gen(function* () {
    const context = yield* Layer.build(
      layer({
        workspace,
        workspaceDigest: "doctor",
        dataRoot,
        runtimeVersion: process.versions.bun,
        trustMode: "trusted-local",
        servers: [],
        registry: HostBindingRegistry.layerTest({
          descriptors: [],
          resolve: (request) => Effect.fail(HostBindingRegistry.HostBindingNotFound.make({ module: request.module })),
          invoke: (request) => Effect.fail(HostBindingRegistry.HostBindingNotFound.make({ module: request.module })),
        }),
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
    yield* Effect.log("41,42")
  }),
)

await Effect.runPromise(program)
