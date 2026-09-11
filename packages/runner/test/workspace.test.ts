/* oxlint-disable max-lines -- this file keeps the checkout and process acceptance probes together. */

/* oxlint-disable effecttsgo/strict-effect-provide -- the checkout fixture builds a short-lived contextual grep service. */

import * as BunServices from "@effect/platform-bun/BunServices"
import { HandshakeRequest, WorkspaceBinding, type WorkspaceExecutorService } from "@rika/execution"
import * as NativeResult from "@rika/product/native-tool-result"
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { RunnerGrep, layer as grepLayer } from "../src/grep"
import { RunnerNativeRuntime, type RunnerNativeRuntimeService } from "../src/native/runtime"
import { Search, missingSearchProvider } from "../src/search"
import { makeLocalWorkspaceExecutor, makeNativeOperationIntent } from "../src/workspace"

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

const runnerBinding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "runner-workspace",
  assignmentId: "runner-assignment",
  generation: 1,
  placement: { _tag: "Runner", workspaceId: "runner-workspace", checkoutFingerprint: "runner-checkout" },
  buildId: "runner-build",
  protocolVersion: 1,
})

const orbBinding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "orb-workspace",
  assignmentId: "orb-assignment",
  generation: 1,
  placement: { _tag: "Orb", workspaceId: "orb-workspace", lineageId: "orb-lineage" },
  buildId: "orb-build",
  protocolVersion: 1,
})

const staleOrbBinding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "orb-workspace",
  assignmentId: "orb-assignment",
  generation: 1,
  placement: { _tag: "Orb", workspaceId: "orb-workspace", lineageId: "stale-lineage" },
  buildId: "orb-build",
  protocolVersion: 1,
})

const inconsistentOrbBinding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "orb-workspace",
  assignmentId: "orb-assignment",
  generation: 1,
  placement: { _tag: "Orb", workspaceId: "other-workspace", lineageId: "orb-lineage" },
  buildId: "orb-build",
  protocolVersion: 1,
})

const runtimeResult = (text: string): NativeResult.Result => ({ text, truncated: false })

const workspaceWith = (checkout: string, binding: WorkspaceBinding, runtime: RunnerNativeRuntimeService) =>
  makeLocalWorkspaceExecutor({ checkout, binding }).pipe(
    Effect.provideService(RunnerNativeRuntime, RunnerNativeRuntime.of(runtime)),
    Effect.provideService(Search, Search.of(missingSearchProvider)),
    Effect.provide(grepLayer(checkout)),
  )

const dispatch = (
  workspace: WorkspaceExecutorService,
  binding: WorkspaceBinding,
  operationId: string,
  tool: string,
  input: Schema.Json,
) =>
  Effect.gen(function* () {
    const intent = makeNativeOperationIntent({ binding, operationId, tool, input })
    const handshake = yield* workspace.handshake(HandshakeRequest.make({ binding }))
    return yield* workspace.dispatch(intent, input, handshake)
  })

const unusedObservation = (processId: string) =>
  Effect.succeed({ processId, exitCode: 0, elapsedMillis: 0, truncated: false })

it.effect("grep traverses a real checkout deterministically and bounds oversized output", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-v2-grep-" })
      yield* fileSystem.makeDirectory(`${checkout}/nested`)
      yield* fileSystem.writeFileString(`${checkout}/nested/z.txt`, "needle z\n")
      yield* fileSystem.writeFileString(`${checkout}/a.txt`, "needle a\nother\n")
      yield* fileSystem.writeFileString(`${checkout}/ignored.txt`, "needle ignored\n")
      const runnerGrep = yield* RunnerGrep.pipe(Effect.provide(grepLayer(checkout)))
      const ordered = yield* runnerGrep.run({ pattern: "needle", glob: "*.txt" })
      expect(ordered).toEqual({
        text: "a.txt:1:needle a\nignored.txt:1:needle ignored\nnested/z.txt:1:needle z",
        truncated: false,
      })

      const large = "needle\n".repeat(20_000)
      yield* fileSystem.writeFileString(`${checkout}/large.txt`, large)
      const bounded = yield* runnerGrep.run({ pattern: "needle", path: "large.txt", max_results: 1_000 })
      expect(new TextEncoder().encode(bounded.text).byteLength).toBeLessThanOrEqual(NativeResult.maxOutputBytes)
      expect(bounded.truncated).toBe(true)
    }),
  ),
)

it.effect("keeps Bash mutation exclusion with owned execution after its dispatch waiter disconnects", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-v2-owned-gate-" })
      yield* fileSystem.writeFileString(`${checkout}/editable.txt`, "before\n")
      const bashStarted = yield* Deferred.make<void>()
      const releaseBash = yield* Deferred.make<void>()
      const editStarted = yield* Deferred.make<void>()
      const runtime: RunnerNativeRuntimeService = {
        observeProcess: unusedObservation,
        run: (request) => {
          if (request._tag === "Bash")
            return Deferred.succeed(bashStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseBash)),
              Effect.as(runtimeResult("bash finished")),
            )
          if (request._tag === "Edit")
            return Deferred.succeed(editStarted, undefined).pipe(
              Effect.andThen(fileSystem.writeFileString(request.path, "after\n").pipe(Effect.orDie)),
              Effect.as(runtimeResult("edited")),
            )
          return Effect.succeed(runtimeResult("read"))
        },
      }
      const workspace = yield* workspaceWith(checkout, runnerBinding, runtime)
      const bashInput = { command: "held command", timeout_ms: 0 }
      const bashWaiter = yield* Effect.forkChild(dispatch(workspace, runnerBinding, "owned-bash", "bash", bashInput))
      yield* Deferred.await(bashStarted)
      yield* Fiber.interrupt(bashWaiter)
      expect(yield* workspace.receipt("owned-bash")).toBeUndefined()

      const edit = yield* Effect.forkChild(
        dispatch(workspace, runnerBinding, "blocked-edit", "edit", {
          path: "editable.txt",
          old_str: "before",
          new_str: "after",
        }),
      )
      yield* Effect.yieldNow
      expect(Option.isNone(yield* Deferred.poll(editStarted))).toBe(true)
      expect(yield* fileSystem.readFileString(`${checkout}/editable.txt`)).toBe("before\n")

      yield* Deferred.succeed(releaseBash, undefined)
      yield* Deferred.await(editStarted).pipe(Effect.timeout("1 second"))
      expect(yield* Fiber.join(edit)).toMatchObject({ outcome: { _tag: "Completed" } })
      expect(yield* fileSystem.readFileString(`${checkout}/editable.txt`)).toBe("after\n")
      const bashReceipt = yield* Effect.gen(function* () {
        while (true) {
          const receipt = yield* workspace.receipt("owned-bash")
          if (receipt !== undefined) return receipt
          yield* Effect.yieldNow
        }
      }).pipe(Effect.timeout("1 second"))
      expect(bashReceipt).toMatchObject({ outcome: { _tag: "Completed" } })
    }),
  ),
)

it.effect("releases Bash mutation exclusion only after explicit cancellation cleanup completes", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-v2-cancel-gate-" })
      yield* fileSystem.writeFileString(`${checkout}/editable.txt`, "before\n")
      const bashStarted = yield* Deferred.make<void>()
      const holdBash = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const releaseCleanup = yield* Deferred.make<void>()
      const editStarted = yield* Deferred.make<void>()
      const cancellationFinished = yield* Deferred.make<void>()
      const runtime: RunnerNativeRuntimeService = {
        observeProcess: unusedObservation,
        run: (request) => {
          if (request._tag === "Bash")
            return Deferred.succeed(bashStarted, undefined).pipe(
              Effect.andThen(Deferred.await(holdBash)),
              Effect.as(runtimeResult("unreachable")),
              Effect.onInterrupt(() =>
                Effect.uninterruptible(
                  Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(releaseCleanup))),
                ),
              ),
            )
          if (request._tag === "Edit")
            return Deferred.succeed(editStarted, undefined).pipe(Effect.as(runtimeResult("edited")))
          return Effect.succeed(runtimeResult("read"))
        },
      }
      const workspace = yield* workspaceWith(checkout, runnerBinding, runtime)
      const running = yield* Effect.forkChild(
        dispatch(workspace, runnerBinding, "cancelled-bash", "bash", { command: "held command", timeout_ms: 0 }),
      )
      yield* Deferred.await(bashStarted)
      const cancellation = yield* Effect.forkChild(
        workspace.cancel("cancelled-bash").pipe(Effect.tap(() => Deferred.succeed(cancellationFinished, undefined))),
      )
      yield* Deferred.await(cleanupStarted)

      const edit = yield* Effect.forkChild(
        dispatch(workspace, runnerBinding, "edit-after-cancel", "edit", {
          path: "editable.txt",
          old_str: "before",
          new_str: "after",
        }),
      )
      yield* Effect.yieldNow
      expect(Option.isNone(yield* Deferred.poll(editStarted))).toBe(true)
      expect(Option.isNone(yield* Deferred.poll(cancellationFinished))).toBe(true)

      yield* Deferred.succeed(releaseCleanup, undefined)
      expect(yield* Fiber.join(cancellation)).toEqual({ _tag: "Cancelled" })
      yield* Deferred.await(editStarted).pipe(Effect.timeout("1 second"))
      expect(yield* Fiber.join(edit)).toMatchObject({ outcome: { _tag: "Completed" } })
      const cancelled = yield* Fiber.join(running)
      expect(cancelled).toMatchObject({ outcome: { _tag: "Unknown" } })
      expect(yield* workspace.receipt("cancelled-bash")).toEqual(cancelled)
      expect(yield* workspace.cancel("cancelled-bash")).toMatchObject({
        _tag: "AlreadyTerminal",
        result: { _tag: "Unknown", operationId: "cancelled-bash" },
      })
    }),
  ),
)

it.effect("serializes same-file Edit execution without serializing different files", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-v2-edit-gate-" })
      yield* fileSystem.writeFileString(`${checkout}/first.txt`, "first\n")
      yield* fileSystem.writeFileString(`${checkout}/second.txt`, "second\n")
      const firstStarted = yield* Deferred.make<void>()
      const releaseFirst = yield* Deferred.make<void>()
      const sameFileStarted = yield* Deferred.make<void>()
      const otherFileStarted = yield* Deferred.make<void>()
      let firstCalls = 0
      const runtime: RunnerNativeRuntimeService = {
        observeProcess: unusedObservation,
        run: (request) => {
          if (request._tag !== "Edit") return Effect.succeed(runtimeResult("unused"))
          if (request.path.endsWith("/second.txt"))
            return Deferred.succeed(otherFileStarted, undefined).pipe(Effect.as(runtimeResult("other")))
          firstCalls += 1
          if (firstCalls === 1)
            return Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.as(runtimeResult("first")),
            )
          return Deferred.succeed(sameFileStarted, undefined).pipe(Effect.as(runtimeResult("same")))
        },
      }
      const workspace = yield* workspaceWith(checkout, runnerBinding, runtime)
      const editInput = { path: "first.txt", old_str: "first", new_str: "changed" }
      const first = yield* Effect.forkChild(dispatch(workspace, runnerBinding, "first-edit", "edit", editInput))
      yield* Deferred.await(firstStarted)
      const same = yield* Effect.forkChild(dispatch(workspace, runnerBinding, "same-edit", "edit", editInput))
      const other = yield* Effect.forkChild(
        dispatch(workspace, runnerBinding, "other-edit", "edit", {
          path: "second.txt",
          old_str: "second",
          new_str: "changed",
        }),
      )
      yield* Deferred.await(otherFileStarted).pipe(Effect.timeout("1 second"))
      expect(Option.isNone(yield* Deferred.poll(sameFileStarted))).toBe(true)
      yield* Deferred.succeed(releaseFirst, undefined)
      yield* Deferred.await(sameFileStarted).pipe(Effect.timeout("1 second"))
      yield* Fiber.join(first)
      yield* Fiber.join(same)
      yield* Fiber.join(other)
    }),
  ),
)

it.effect("accepts only an explicitly supplied consistent Orb binding and retains the complete fence", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-v2-orb-binding-" })
      yield* fileSystem.writeFileString(`${checkout}/fixture.txt`, "fixture\n")
      let runs = 0
      const runtime: RunnerNativeRuntimeService = {
        observeProcess: unusedObservation,
        run: () =>
          Effect.sync(() => {
            runs += 1
            return runtimeResult("read")
          }),
      }
      const workspace = yield* workspaceWith(checkout, orbBinding, runtime)
      expect(workspace.binding).toEqual(orbBinding)
      const orbHandshake = yield* workspace.handshake(HandshakeRequest.make({ binding: orbBinding }))
      expect(orbHandshake).toMatchObject({
        placement: { _tag: "Orb", lineageId: "orb-lineage" },
      })

      expect(
        yield* Effect.result(workspace.handshake(HandshakeRequest.make({ binding: staleOrbBinding }))),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: "placement" },
      })
      const staleIntent = makeNativeOperationIntent({
        binding: staleOrbBinding,
        operationId: "stale-orb-read",
        tool: "read",
        input: { path: "fixture.txt" },
      })
      expect(
        yield* Effect.result(workspace.dispatch(staleIntent, { path: "fixture.txt" }, orbHandshake)),
      ).toMatchObject({ _tag: "Failure", failure: { reason: "placement" } })
      expect(runs).toBe(0)

      expect(yield* Effect.result(workspaceWith(checkout, inconsistentOrbBinding, runtime))).toMatchObject({
        _tag: "Failure",
        failure: { kind: "binding" },
      })
    }),
  ),
)
