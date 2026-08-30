import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { describe, expect, it } from "@effect/vitest"
import { Context, Crypto, Deferred, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as BindingProxy from "../../src/protocol/binding-proxy"
import { bindingManifest, type CellRequest } from "../../src/protocol/messages"

const access = {
  version: 1 as const,
  fence: {
    target: "orb" as const,
    assignmentId: "assignment-1",
    assignmentGeneration: 1,
    instanceId: "sandbox-1",
    executorId: "executor-1",
    processIncarnation: "process-1",
  },
  leaseEpoch: 1,
  sessionToken: "session-1",
}

class AwaitTimeout extends Schema.TaggedError<AwaitTimeout>()("AwaitTimeout", {}) {}

const eventually = <A>(read: () => A | undefined): Effect.Effect<A, AwaitTimeout> =>
  Effect.suspend(() => {
    const value = read()
    return value === undefined ? Effect.yieldNow.pipe(Effect.andThen(eventually(read))) : Effect.succeed(value)
  }).pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => AwaitTimeout.make(),
    }),
  )

describe("binding proxy", () => {
  it.effect("rejects a forged digest and reports unknown authority without a fabricated binding failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invalid = yield* Effect.result(
          BindingProxy.make({
            manifest: { digest: "f".repeat(64), descriptors: [{ module: "workspace", operations: ["read"] }] },
            transport: { send: () => Effect.void },
          }),
        )
        expect(invalid._tag).toBe("Failure")

        const manifest = yield* bindingManifest([{ module: "workspace", operations: ["read"] }])
        const sent: Array<Parameters<BindingProxy.Transport["send"]>[0]> = []
        const proxy = yield* BindingProxy.make({
          manifest,
          transport: { send: (message) => Effect.sync(() => sent.push(message)) },
        })
        const cell: CellRequest = {
          access,
          operationKey: "operation-unknown",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "run-1",
          rootRunId: "run-1",
          toolCallId: "call-unknown",
          code: "await rika.workspace.read({ path: 'a' })",
          attempt: 0,
          replayPolicy: "never",
          admittedAt: null,
          deadlineAt: "2999-01-01T00:00:00.000Z",
          bindings: manifest,
        }
        yield* proxy.enter(cell)
        yield* Effect.forkScoped(
          proxy.registry.invoke({
            module: "workspace",
            operation: "read",
            input: { path: "a" },
            sessionId: cell.sessionId,
            cellId: cell.toolCallId,
          }),
        )
        const call = yield* eventually(() => sent[0])
        yield* proxy.complete({
          operationKey: call.operationKey,
          attempt: call.attempt,
          callId: call.callId,
          requestDigest: call.requestDigest,
          outcome: { _tag: "Unknown", message: "authority lost after crossing" },
        })
        expect(yield* proxy.unknown(cell)).toBe("authority lost after crossing")
      }).pipe(
        Effect.provideServiceEffect(
          Crypto.Crypto,
          Effect.scoped(Layer.build(BunCrypto.layer)).pipe(
            Effect.map((context) => Context.get(context, Crypto.Crypto)),
          ),
        ),
      ),
    ),
  )

  it.effect("terminally resolves a pending binding invocation at its finite cell deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manifest = yield* bindingManifest([{ module: "context", operations: ["current"] }])
        const sent = yield* Deferred.make<Parameters<BindingProxy.Transport["send"]>[0]>()
        const proxy = yield* BindingProxy.make({
          manifest,
          transport: { send: (message) => Deferred.succeed(sent, message).pipe(Effect.asVoid) },
        })
        const cell: CellRequest = {
          access,
          operationKey: "operation-deadline",
          workspaceId: "workspace-1",
          sessionId: "session-deadline",
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "run-1",
          rootRunId: "run-1",
          toolCallId: "call-deadline",
          code: "context",
          attempt: 0,
          replayPolicy: "never",
          admittedAt: "1970-01-01T00:00:00.000Z",
          deadlineAt: "1970-01-01T00:00:01.000Z",
          bindings: manifest,
        }
        yield* proxy.enter(cell)
        const finished = yield* Deferred.make<void>()
        yield* Effect.forkScoped(
          Effect.result(
            proxy.registry.invoke({
              module: "context",
              operation: "current",
              input: {},
              sessionId: cell.sessionId,
              cellId: cell.toolCallId,
            }),
          ).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
        )
        yield* Deferred.await(sent)
        yield* TestClock.adjust("1 second")
        yield* Effect.yieldNow
        expect((yield* Deferred.poll(finished))._tag).toBe("Some")
      }).pipe(
        Effect.provideServiceEffect(
          Crypto.Crypto,
          Effect.scoped(Layer.build(BunCrypto.layer)).pipe(
            Effect.map((context) => Context.get(context, Crypto.Crypto)),
          ),
        ),
      ),
    ),
  )

  it.effect("terminally resolves an invocation whose outcome is unknown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manifest = yield* bindingManifest([{ module: "context", operations: ["current"] }])
        const sent = yield* Deferred.make<Parameters<BindingProxy.Transport["send"]>[0]>()
        const proxy = yield* BindingProxy.make({
          manifest,
          transport: { send: (message) => Deferred.succeed(sent, message).pipe(Effect.asVoid) },
        })
        const cell: CellRequest = {
          access,
          operationKey: "operation-terminal-unknown",
          workspaceId: "workspace-1",
          sessionId: "session-terminal-unknown",
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "run-1",
          rootRunId: "run-1",
          toolCallId: "call-terminal-unknown",
          code: "context",
          attempt: 0,
          replayPolicy: "never",
          admittedAt: null,
          deadlineAt: "2999-01-01T00:00:00.000Z",
          bindings: manifest,
        }
        yield* proxy.enter(cell)
        const finished = yield* Deferred.make<void>()
        yield* Effect.forkScoped(
          Effect.result(
            proxy.registry.invoke({
              module: "context",
              operation: "current",
              input: {},
              sessionId: cell.sessionId,
              cellId: cell.toolCallId,
            }),
          ).pipe(Effect.ensuring(Deferred.succeed(finished, undefined))),
        )
        const call = yield* Deferred.await(sent)
        yield* proxy.complete({
          operationKey: call.operationKey,
          attempt: call.attempt,
          callId: call.callId,
          requestDigest: call.requestDigest,
          outcome: { _tag: "Unknown", message: "authority lost after crossing" },
        })
        yield* Effect.yieldNow
        expect((yield* Deferred.poll(finished))._tag).toBe("Some")
      }).pipe(
        Effect.provideServiceEffect(
          Crypto.Crypto,
          Effect.scoped(Layer.build(BunCrypto.layer)).pipe(
            Effect.map((context) => Context.get(context, Crypto.Crypto)),
          ),
        ),
      ),
    ),
  )

  it.effect("rejects late results after deadline or unknown terminality", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manifest = yield* bindingManifest([{ module: "context", operations: ["current"] }])
        const sent: Array<Parameters<BindingProxy.Transport["send"]>[0]> = []
        const proxy = yield* BindingProxy.make({
          manifest,
          transport: { send: (message) => Effect.sync(() => sent.push(message)) },
        })
        const cell: CellRequest = {
          access,
          operationKey: "operation-late",
          workspaceId: "workspace-1",
          sessionId: "session-late",
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "run-1",
          rootRunId: "run-1",
          toolCallId: "call-late",
          code: "context",
          attempt: 0,
          replayPolicy: "never",
          admittedAt: "1970-01-01T00:00:00.000Z",
          deadlineAt: "1970-01-01T00:00:01.000Z",
          bindings: manifest,
        }
        yield* proxy.enter(cell)
        yield* Effect.forkScoped(
          proxy.registry.invoke({
            module: "context",
            operation: "current",
            input: {},
            sessionId: cell.sessionId,
            cellId: cell.toolCallId,
          }),
        )
        const call = yield* eventually(() => sent[0])
        yield* TestClock.adjust("1 second")
        const afterDeadline = yield* Effect.result(
          proxy.complete({
            operationKey: call.operationKey,
            attempt: call.attempt,
            callId: call.callId,
            requestDigest: call.requestDigest,
            outcome: { _tag: "Returned", response: { _tag: "Success", output: {} } },
          }),
        )

        const unknownCell = {
          ...cell,
          operationKey: "operation-late-unknown",
          toolCallId: "call-late-unknown",
          deadlineAt: "2999-01-01T00:00:00.000Z",
        }
        yield* proxy.enter(unknownCell)
        yield* Effect.forkScoped(
          proxy.registry.invoke({
            module: "context",
            operation: "current",
            input: {},
            sessionId: unknownCell.sessionId,
            cellId: unknownCell.toolCallId,
          }),
        )
        const unknownCall = yield* eventually(() => sent[1])
        yield* proxy.complete({
          operationKey: unknownCall.operationKey,
          attempt: unknownCall.attempt,
          callId: unknownCall.callId,
          requestDigest: unknownCall.requestDigest,
          outcome: { _tag: "Unknown", message: "authority lost" },
        })
        const afterUnknown = yield* Effect.result(
          proxy.complete({
            operationKey: unknownCall.operationKey,
            attempt: unknownCall.attempt,
            callId: unknownCall.callId,
            requestDigest: unknownCall.requestDigest,
            outcome: { _tag: "Returned", response: { _tag: "Success", output: {} } },
          }),
        )
        expect(afterDeadline._tag).toBe("Failure")
        expect(afterUnknown._tag).toBe("Failure")
      }).pipe(
        Effect.provideServiceEffect(
          Crypto.Crypto,
          Effect.scoped(Layer.build(BunCrypto.layer)).pipe(
            Effect.map((context) => Context.get(context, Crypto.Crypto)),
          ),
        ),
      ),
    ),
  )

  it.effect("does not replay expired or unknown replayPolicy never mutations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manifest = yield* bindingManifest([{ module: "context", operations: ["current"] }])
        const sent: Array<Parameters<BindingProxy.Transport["send"]>[0]> = []
        const proxy = yield* BindingProxy.make({
          manifest,
          transport: { send: (message) => Effect.sync(() => sent.push(message)) },
        })
        const cell: CellRequest = {
          access,
          operationKey: "operation-no-replay",
          workspaceId: "workspace-1",
          sessionId: "session-no-replay",
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "run-1",
          rootRunId: "run-1",
          toolCallId: "call-no-replay",
          code: "context",
          attempt: 0,
          replayPolicy: "never",
          admittedAt: "1970-01-01T00:00:00.000Z",
          deadlineAt: "1970-01-01T00:00:01.000Z",
          bindings: manifest,
        }
        yield* proxy.enter(cell)
        yield* Effect.forkScoped(
          proxy.registry.invoke({
            module: "context",
            operation: "current",
            input: {},
            sessionId: cell.sessionId,
            cellId: cell.toolCallId,
          }),
        )
        const expiredCall = yield* eventually(() => sent[0])
        yield* TestClock.adjust("1 second")
        yield* proxy.replay({ ...access, leaseEpoch: 2 })
        const sendsAfterExpiredReplay = sent.length

        const unknownCell = {
          ...cell,
          operationKey: "operation-no-replay-unknown",
          toolCallId: "call-no-replay-unknown",
          deadlineAt: "2999-01-01T00:00:00.000Z",
        }
        yield* proxy.enter(unknownCell)
        yield* Effect.forkScoped(
          proxy.registry.invoke({
            module: "context",
            operation: "current",
            input: {},
            sessionId: unknownCell.sessionId,
            cellId: unknownCell.toolCallId,
          }),
        )
        const unknownCall = yield* eventually(() => sent.find((message) => message.callId !== expiredCall.callId))
        yield* proxy.complete({
          operationKey: unknownCall.operationKey,
          attempt: unknownCall.attempt,
          callId: unknownCall.callId,
          requestDigest: unknownCall.requestDigest,
          outcome: { _tag: "Unknown", message: "authority lost" },
        })
        const beforeUnknownReplay = sent.length
        yield* proxy.replay({ ...access, leaseEpoch: 3 })
        expect(sendsAfterExpiredReplay).toBe(1)
        expect(sent).toHaveLength(beforeUnknownReplay)
      }).pipe(
        Effect.provideServiceEffect(
          Crypto.Crypto,
          Effect.scoped(Layer.build(BunCrypto.layer)).pipe(
            Effect.map((context) => Context.get(context, Crypto.Crypto)),
          ),
        ),
      ),
    ),
  )
})
