import * as BunServices from "@effect/platform-bun/BunServices"
import { Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { RunnerNativeRuntime, layerWithProcessRegistry } from "../src/native/runtime"
import * as ProcessRegistry from "../src/native/process-registry"

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

const activeOutput = (processId: string): ProcessRegistry.Output => ({
  processId,
  stdout: "partial",
  stderr: "",
  running: true,
  elapsedMillis: 1,
  truncated: false,
})

const runtimeWith = (checkout: string, registry: ProcessRegistry.Interface) =>
  Layer.build(layerWithProcessRegistry(checkout).pipe(Layer.provide(ProcessRegistry.testLayer(registry)))).pipe(
    Effect.map((context) => Context.get(context, RunnerNativeRuntime)),
  )

it.effect("cancels a Bash handle acquired while its caller is being interrupted", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-v2-acquire-" })
      const acquisitionStarted = yield* Deferred.make<void>()
      const releaseAcquisition = yield* Deferred.make<void>()
      const cancelled = yield* Deferred.make<string>()
      let polls = 0
      const registry: ProcessRegistry.Interface = {
        start: () =>
          Deferred.succeed(acquisitionStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseAcquisition)),
            Effect.as("acquired-process"),
          ),
        poll: (processId) =>
          Effect.sync(() => {
            polls += 1
            return activeOutput(processId)
          }),
        observe: (processId) => Effect.succeed({ processId, exitCode: 0, elapsedMillis: 1, truncated: false }),
        cancel: (processId) => Deferred.succeed(cancelled, processId).pipe(Effect.asVoid),
      }
      const runtime = yield* runtimeWith(checkout, registry)
      const call = yield* Effect.forkChild(runtime.run({ _tag: "Bash", command: "held acquisition", timeoutMillis: 0 }))
      yield* Deferred.await(acquisitionStarted)
      const interruption = yield* Effect.forkChild(Fiber.interrupt(call))
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(cancelled)).toBe(false)

      yield* Deferred.succeed(releaseAcquisition, undefined)
      yield* Fiber.join(interruption)
      expect(yield* Deferred.await(cancelled)).toBe("acquired-process")
      const outcome = yield* Fiber.await(call)
      expect(Exit.isFailure(outcome) && Cause.hasInterrupts(outcome.cause)).toBe(true)
      expect(polls).toBe(0)
    }),
  ),
)

it.effect("joins Bash cleanup and returns a failure when terminal observation fails", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-v2-observe-" })
      const cleanupStarted = yield* Deferred.make<string>()
      const releaseCleanup = yield* Deferred.make<void>()
      const completed = yield* Deferred.make<void>()
      let observations = 0
      const registry: ProcessRegistry.Interface = {
        start: () => Effect.succeed("observed-process"),
        poll: (processId) => Effect.succeed(activeOutput(processId)),
        observe: () => {
          observations += 1
          return Effect.fail(new ProcessRegistry.ProcessNotFound({ message: "terminal observation unavailable" }))
        },
        cancel: (processId) =>
          Deferred.succeed(cleanupStarted, processId).pipe(
            Effect.andThen(Deferred.await(releaseCleanup)),
            Effect.asVoid,
          ),
      }
      const runtime = yield* runtimeWith(checkout, registry)
      const call = yield* Effect.forkChild(
        Effect.result(runtime.run({ _tag: "Bash", command: "failed observation", timeoutMillis: 0 })).pipe(
          Effect.tap(() => Deferred.succeed(completed, undefined)),
        ),
      )
      expect(yield* Deferred.await(cleanupStarted)).toBe("observed-process")
      expect(yield* Deferred.isDone(completed)).toBe(false)

      yield* Deferred.succeed(releaseCleanup, undefined)
      expect(yield* Fiber.join(call)).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ToolError",
          tool: "bash",
          category: "not_found",
          outcome: "unknown",
        },
      })
      expect(observations).toBe(1)
      expect(yield* Deferred.isDone(completed)).toBe(true)
    }),
  ),
)
