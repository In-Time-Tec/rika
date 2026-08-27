import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { CellExecutor, layer as cellExecutorLayer } from "@rika/kernel/cell-executor"
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { HostBindingRegistry } from "tenetkit/repl"
import { kernelRuntime, kernelWorker } from "./package-contract"

const smoke = Effect.fn("Package.kernelRuntimeSmoke")(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-package-kernel-workspace-" })
  const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-package-kernel-data-" })
  const context = yield* Layer.build(
    cellExecutorLayer({
      workspace,
      workspaceDigest: "package-kernel-smoke",
      dataRoot,
      runtimeVersion: Bun.version,
      runtimeCommand: path.join(directory, kernelRuntime),
      workerModule: path.join(directory, kernelWorker),
      trustMode: "trusted-local",
      servers: [],
      registry: HostBindingRegistry.layer([]),
    }).pipe(Layer.provide(BunServices.layer)),
  )
  const result = yield* Context.get(context, CellExecutor).execute({
    sessionId: "package-kernel-smoke",
    cellId: "package-kernel-smoke",
    code: "6 * 7",
  })
  if (result._tag !== "Success" || result.result.value !== "42")
    return yield* Effect.die(new Error("Packaged kernel returned an unexpected result"))
  yield* Effect.log("PACKAGE_KERNEL_OK")
})

const command = Command.make("kernel-runtime-smoke", { directory: Argument.string("directory") }, ({ directory }) =>
  Effect.scoped(smoke(directory)),
)
const main = Command.run(command, { version: "0.0.0" })

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(main, context))),
  )
