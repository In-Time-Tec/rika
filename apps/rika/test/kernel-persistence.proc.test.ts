import { expect, layer } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import { KernelPool } from "tenetkit/repl"
import { Context, Effect, FileSystem, Layer } from "effect"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as GoalRepository from "@rika/product/goal-repository"
import * as ThreadQuery from "@rika/product/thread-query-service"
import * as Kernel from "./kernel-layer"

layer(BunServices.layer)("composed kernel", (it) => {
  /**
   * The kernel is persistent, so a value one cell declares is still bound for the next cell of the
   * same Session. That only holds while the pool outlives a single turn: a pool rebuilt per Run
   * would answer the second cell from a fresh worker, and the binding would be gone.
   */
  it.effect("keeps a Session's namespace across cells", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const dataRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-persist-" })
      const workspace = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-persist-ws-" })
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
      const run = (cellId: string, code: string) =>
        Effect.flatMap(
          pool.execute({ sessionId: "persist", cellId, code, signal: AbortSignal.any([]) }),
          (execution) => execution.result,
        )
      yield* run("c1", "globalThis.remembered = 41")
      const second = yield* run("c2", "remembered + 1")
      expect(second.value).toBe("42")
    }),
  )
})
