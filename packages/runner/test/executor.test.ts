import { Deferred, Effect, Fiber, Schema } from "effect"
import { it } from "@effect/vitest"
import { describe, expect } from "vitest"

import { HandshakeRequest, WorkspaceBinding } from "@rika/execution"
import * as NativeResult from "@rika/product/native-tool-result"

import { makeRunnerExecutor, type RunnerToolRequest } from "../src/executor"
import { makeNativeOperationIntent } from "../src/workspace"
import { missingSearchProvider } from "../src/search"

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "runner-test-workspace",
  assignmentId: "runner-test-assignment",
  generation: 1,
  placement: {
    _tag: "Runner",
    workspaceId: "runner-test-workspace",
    checkoutFingerprint: "runner-test-checkout",
  },
  buildId: "runner-test-build",
  protocolVersion: 1,
})

const bashRequest: RunnerToolRequest = { _tag: "Bash", command: "printf runner" }

const result = (text: string): NativeResult.Result => ({ text, truncated: false })

describe("runner-v2 executor", () => {
  it.effect("executes one admitted request, returns a typed receipt, and never reruns a cached identity", () =>
    Effect.gen(function* () {
      let runs = 0
      const executor = yield* makeRunnerExecutor(
        {
          binding,
          runtime: {
            run: () =>
              Effect.sync(() => {
                runs += 1
                return result("runner")
              }),
            observeProcess: () => Effect.succeed({ processId: "unused", exitCode: 0, elapsedMillis: 0, truncated: false }),
          },
          grep: () => Effect.succeed(result("grep")),
        },
        missingSearchProvider,
      )
      const intent = makeNativeOperationIntent({
        binding,
        operationId: "runner-operation-1",
        tool: "bash",
        input: bashRequest,
      })
      yield* executor.register(intent, bashRequest)
      const handshake = yield* executor.handshake(HandshakeRequest.make({ binding }))
      const first = yield* executor.dispatch(intent, handshake)
      const second = yield* executor.dispatch(intent, handshake)
      expect(first).toMatchObject({ operationId: intent.operationId, outcome: { _tag: "Completed" } })
      expect(second).toEqual(first)
      expect(runs).toBe(1)
      expect(yield* executor.receipt(intent.operationId)).toEqual(first)
    }),
  )

  it.effect("interrupts a running request and retains an Unknown receipt for repeated cancellation", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const executor = yield* makeRunnerExecutor(
        {
          binding,
          runtime: {
            run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release)), Effect.map(() => result("late"))),
            observeProcess: () => Effect.succeed({ processId: "unused", exitCode: 0, elapsedMillis: 0, truncated: false }),
          },
          grep: () => Effect.succeed(result("grep")),
        },
        missingSearchProvider,
      )
      const intent = makeNativeOperationIntent({
        binding,
        operationId: "runner-operation-cancel",
        tool: "bash",
        input: bashRequest,
      })
      yield* executor.register(intent, bashRequest)
      const handshake = yield* executor.handshake(HandshakeRequest.make({ binding }))
      const dispatch = yield* Effect.forkChild(executor.dispatch(intent, handshake))
      yield* Deferred.await(started)
      expect(yield* executor.cancel(intent.operationId)).toEqual({ _tag: "Cancelled" })
      const settled = yield* Fiber.join(dispatch)
      expect(settled).toMatchObject({ operationId: intent.operationId, outcome: { _tag: "Unknown" } })
      expect(yield* executor.receipt(intent.operationId)).toEqual(settled)
      expect(yield* executor.cancel(intent.operationId)).toMatchObject({ _tag: "AlreadyTerminal" })
    }),
  )

  it.effect("returns an explicit typed provider failure when web credentials are absent", () =>
    Effect.gen(function* () {
      const executor = yield* makeRunnerExecutor(
        {
          binding,
          runtime: {
            run: () => Effect.succeed(result("native")),
            observeProcess: () => Effect.succeed({ processId: "unused", exitCode: 0, elapsedMillis: 0, truncated: false }),
          },
          grep: () => Effect.succeed(result("grep")),
        },
        missingSearchProvider,
      )
      const request: RunnerToolRequest = { _tag: "WebSearch", parameters: { query: "Effect" } }
      const intent = makeNativeOperationIntent({
        binding,
        operationId: "runner-operation-search",
        tool: "web_search",
        input: request,
      })
      yield* executor.register(intent, request)
      const handshake = yield* executor.handshake(HandshakeRequest.make({ binding }))
      const output = yield* executor.dispatch(intent, handshake)
      expect(output).toMatchObject({
        operationId: intent.operationId,
        outcome: { _tag: "DomainFailure", failure: { category: "dependency_unavailable" } },
      })
    }),
  )
})
