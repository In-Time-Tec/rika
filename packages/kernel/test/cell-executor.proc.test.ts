import * as BunServices from "@effect/platform-bun/BunServices"
import { describe, expect, it } from "@effect/vitest"
import { HostModules } from "tenetkit/repl"
import { Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer } from "effect"
import { CellExecutor, layer } from "../src/cell-executor"

const withExecutor = <A, E, R>(use: (executor: CellExecutor["Service"]) => Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(BunServices.layer), (services) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const root = yield* fileSystem.makeTempDirectoryScoped()
        const context = yield* Layer.build(
          layer({
            workspace: root,
            workspaceDigest: root,
            dataRoot: root,
            runtimeVersion: process.versions.bun,
            trustMode: "trusted-local",
            servers: [],
            registry: HostModules.layerTest({
              descriptors: [],
              resolve: (request) => Effect.fail(HostModules.HostModuleNotFound.make({ module: request.module })),
              invoke: (request) => Effect.fail(HostModules.HostModuleNotFound.make({ module: request.module })),
            }),
          }).pipe(Layer.provide(BunServices.layer)),
        )
        return yield* use(Context.get(context, CellExecutor))
      }).pipe(Effect.provide(services)),
    ),
  )

describe("hosted cell executor", () => {
  it.effect("evaluates TypeScript, persists one Session namespace, and isolates Sessions", () =>
    withExecutor((executor) =>
      Effect.gen(function* () {
        const first = yield* executor.execute({
          sessionId: "a",
          cellId: "a-1",
          code: "let count: number = 1; count",
        })
        const second = yield* executor.execute({ sessionId: "a", cellId: "a-2", code: "count += 1; count" })
        const isolated = yield* executor.execute({ sessionId: "b", cellId: "b-1", code: "typeof count" })
        expect(first._tag === "Success" ? first.result.value : first.failure).toBe("1")
        expect(second._tag === "Success" && second.result.value).toBe("2")
        expect(isolated._tag === "Success" && isolated.result.value).toBe("undefined")
      }),
    ),
  )

  it.effect("returns typed evaluation failures and interrupts the kernel cell", () =>
    withExecutor((executor) =>
      Effect.gen(function* () {
        const failure = yield* executor.execute({
          sessionId: "failure",
          cellId: "failure-1",
          code: "throw new Error('boom')",
        })
        expect(failure._tag).toBe("DomainFailure")
        if (failure._tag === "DomainFailure") expect(failure.failure._tag).toBe("tenetkit/repl/CellExecutionFailed")

        expect(failure._tag === "DomainFailure" && failure.failure._tag).toBe("tenetkit/repl/CellExecutionFailed")

        const started = yield* Deferred.make<void>()
        const running = yield* Effect.forkChild(
          executor.execute({
            sessionId: "interrupt",
            cellId: "interrupt-1",
            code: "console.log('started'); await new Promise(() => {})",
            emit: (event) =>
              event._tag === "Stdout" && event.text.includes("started")
                ? Deferred.succeed(started, undefined).pipe(Effect.asVoid)
                : Effect.void,
          }),
        )
        yield* Deferred.await(started)
        yield* Fiber.interrupt(running)
        const interrupted = yield* Fiber.await(running)
        expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true)

        const recovered = yield* executor.execute({
          sessionId: "interrupt",
          cellId: "interrupt-2",
          code: "'available after interruption'",
        })
        expect(recovered._tag === "Success" ? recovered.result.value : recovered.failure).toBe(
          "available after interruption",
        )
      }),
    ),
  )
})
