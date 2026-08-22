import { expect, layer } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { KernelPool } from "tenetkit/repl"
import { Context, Effect, FileSystem, Layer } from "effect"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as GoalRepository from "@rika/product/goal-repository"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as Kernel from "./kernel-layer"

/**
 * The composed kernel spawns a real Bun worker, so this is a process test rather than a unit one.
 *
 * Every layer of this surface can be correct while the product is dead: TenetKit mounts each binding
 * module as its own flat global, Rika assembles them into `rika`, and until a cell actually names
 * `rika` nothing proves the assembly ever ran. A cell is the only place that fact is observable.
 */
layer(BunServices.layer)("composed kernel", (it) => {
  it.effect("assembles the rika surface in a real worker so a cell can name it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-kernel-live-" })
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-kernel-ws-" })
      const context = yield* Layer.build(
        Kernel.layer({
          workspace,
          home: dataRoot,
          dataRoot,
          runtimeVersion: Bun.version,
          goalRepositoryLayer: GoalRepository.memoryLayer,
          queryFactory: Layer.succeed(
            ThreadQuery.Factory,
            ThreadQuery.Factory.of({ forWorkspace: () => Effect.never } as never),
          ),
          toolRuntimeLayer: Layer.succeed(
            CodingToolRuntime.Service,
            CodingToolRuntime.Service.of({ run: () => Effect.never } as never),
          ),
        }),
      )
      const pool = Context.get(context, KernelPool.KernelPool)
      const execution = yield* pool.execute({
        sessionId: "live-session",
        cellId: "c1",
        code: `typeof rika + ":" + typeof rika.goal.create + ":" + typeof rika.harness.snapshot`,
        signal: AbortSignal.any([]),
      })
      const result = yield* execution.result
      expect(result.value).toBe("object:function:function")
    }),
  )
})
