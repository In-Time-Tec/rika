import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { describe, expect, it } from "@effect/vitest"
import { Context, Crypto, Deferred, Effect, Fiber, Layer, Schema } from "effect"
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
  it.effect("verifies the manifest and replays one stable pending call after reconnect", () =>
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
          operationKey: "operation-1",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "run-1",
          rootRunId: "run-1",
          toolCallId: "call-1",
          code: "context",
          attempt: 0,
          replayPolicy: "never",
          admittedAt: null,
          deadlineAt: "2999-01-01T00:00:00.000Z",
          bindings: manifest,
        }
        yield* proxy.enter(cell)
        const running = yield* Effect.forkScoped(
          proxy.registry.invoke({
            module: "context",
            operation: "current",
            input: {},
            sessionId: "session-1",
            cellId: "call-1",
          }),
        )
        const first = yield* eventually(() => sent[0])
        const renewed = { ...access, leaseEpoch: 2 }
        yield* proxy.replay(renewed)
        expect(sent).toHaveLength(2)
        expect(sent[1]).toEqual({ ...first, access: renewed })
        const conflicting = yield* Effect.result(
          proxy.complete({
            operationKey: first.operationKey,
            attempt: first.attempt,
            callId: first.callId,
            requestDigest: "different-digest",
            outcome: { _tag: "Returned", response: { _tag: "Success", output: {} } },
          }),
        )
        expect(conflicting._tag).toBe("Failure")
        yield* proxy.complete({
          operationKey: first.operationKey,
          attempt: first.attempt,
          callId: first.callId,
          requestDigest: first.requestDigest,
          outcome: { _tag: "Returned", response: { _tag: "Success", output: { threadId: "thread-1" } } },
        })
        expect(yield* Fiber.join(running)).toEqual({ _tag: "Success", output: { threadId: "thread-1" } })
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

  it.effect("replays completed and pending cell bindings in their original order until the cell leaves", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manifest = yield* bindingManifest([
          { module: "context", operations: ["current"] },
          { module: "workspace", operations: ["write"] },
        ])
        const sent: Array<Parameters<BindingProxy.Transport["send"]>[0]> = []
        const proxy = yield* BindingProxy.make({
          manifest,
          transport: { send: (message) => Effect.sync(() => sent.push(message)) },
        })
        const cell: CellRequest = {
          access,
          operationKey: "operation-transcript",
          workspaceId: "workspace-1",
          sessionId: "session-transcript",
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "run-1",
          rootRunId: "run-1",
          toolCallId: "call-transcript",
          code: "context then write",
          attempt: 0,
          replayPolicy: "provider-idempotent",
          admittedAt: null,
          deadlineAt: "2999-01-01T00:00:00.000Z",
          bindings: manifest,
        }
        yield* proxy.enter(cell)
        const context = yield* Effect.forkScoped(
          proxy.registry.invoke({
            module: "context",
            operation: "current",
            input: {},
            sessionId: cell.sessionId,
            cellId: cell.toolCallId,
          }),
        )
        const first = yield* eventually(() => sent[0])
        const firstOutcome = {
          _tag: "Returned" as const,
          response: { _tag: "Success" as const, output: { threadId: "thread-1" } },
        }
        yield* proxy.complete({
          operationKey: first.operationKey,
          attempt: first.attempt,
          callId: first.callId,
          requestDigest: first.requestDigest,
          outcome: firstOutcome,
        })
        expect(yield* Fiber.join(context)).toEqual(firstOutcome.response)
        const write = yield* Effect.forkScoped(
          proxy.registry.invoke({
            module: "workspace",
            operation: "write",
            input: { path: "marker.txt", content: "once" },
            sessionId: cell.sessionId,
            cellId: cell.toolCallId,
          }),
        )
        const second = yield* eventually(() => sent[1])
        sent.length = 0
        const renewed = { ...access, leaseEpoch: 2 }
        yield* proxy.replay(renewed)
        expect(sent).toEqual([
          { ...first, access: renewed },
          { ...second, access: renewed },
        ])
        expect(
          yield* proxy.complete({
            operationKey: first.operationKey,
            attempt: first.attempt,
            callId: first.callId,
            requestDigest: first.requestDigest,
            outcome: firstOutcome,
          }),
        ).toEqual(firstOutcome)
        const secondOutcome = {
          _tag: "Returned" as const,
          response: { _tag: "Success" as const, output: { written: true } },
        }
        yield* proxy.complete({
          operationKey: second.operationKey,
          attempt: second.attempt,
          callId: second.callId,
          requestDigest: second.requestDigest,
          outcome: secondOutcome,
        })
        expect(yield* Fiber.join(write)).toEqual(secondOutcome.response)
        yield* proxy.leave(cell)
        sent.length = 0
        yield* proxy.replay({ ...renewed, leaseEpoch: 3 })
        expect(sent).toEqual([])
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

  it.effect("uses renewed access for binding calls that begin after reconnect", () =>
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
          operationKey: "operation-after-reconnect",
          workspaceId: "workspace-1",
          sessionId: "session-1",
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "run-1",
          rootRunId: "run-1",
          toolCallId: "call-after-reconnect",
          code: "context",
          attempt: 0,
          replayPolicy: "never",
          admittedAt: null,
          deadlineAt: "2999-01-01T00:00:00.000Z",
          bindings: manifest,
        }
        yield* proxy.enter(cell)
        const renewed = { ...access, leaseEpoch: 2 }
        yield* proxy.replay(renewed)
        const running = yield* Effect.forkScoped(
          proxy.registry.invoke({
            module: "context",
            operation: "current",
            input: {},
            sessionId: "session-1",
            cellId: "call-after-reconnect",
          }),
        )
        const request = yield* eventually(() => sent[0])
        expect(request.access).toEqual(renewed)
        yield* proxy.complete({
          operationKey: request.operationKey,
          attempt: request.attempt,
          callId: request.callId,
          requestDigest: request.requestDigest,
          outcome: { _tag: "Returned", response: { _tag: "Success", output: { threadId: "thread-1" } } },
        })
        expect(yield* Fiber.join(running)).toEqual({ _tag: "Success", output: { threadId: "thread-1" } })
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

  it.effect("keeps a binding call pending when transport is lost before reconnect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manifest = yield* bindingManifest([{ module: "context", operations: ["current"] }])
        const sent: Array<Parameters<BindingProxy.Transport["send"]>[0]> = []
        let connected = false
        const proxy = yield* BindingProxy.make({
          manifest,
          transport: {
            send: (message) =>
              connected
                ? Effect.sync(() => sent.push(message))
                : Effect.fail(BindingProxy.BindingProxyError.make({ message: "connection lost" })),
          },
        })
        const cell: CellRequest = {
          access,
          operationKey: "operation-disconnected",
          workspaceId: "workspace-1",
          sessionId: "session-disconnected",
          threadId: "thread-1",
          turnId: "turn-1",
          runId: "run-1",
          rootRunId: "run-1",
          toolCallId: "call-disconnected",
          code: "context",
          attempt: 0,
          replayPolicy: "never",
          admittedAt: null,
          deadlineAt: "2999-01-01T00:00:00.000Z",
          bindings: manifest,
        }
        yield* proxy.enter(cell)
        const completed = yield* Deferred.make<void>()
        const running = yield* Effect.forkScoped(
          proxy.registry
            .invoke({
              module: "context",
              operation: "current",
              input: {},
              sessionId: cell.sessionId,
              cellId: cell.toolCallId,
            })
            .pipe(Effect.ensuring(Deferred.succeed(completed, undefined))),
        )
        yield* Effect.yieldNow
        expect((yield* Deferred.poll(completed))._tag).toBe("None")
        connected = true
        const renewed = { ...access, leaseEpoch: 2 }
        yield* proxy.replay(renewed)
        const replayed = yield* eventually(() => sent[0])
        expect(replayed.access).toEqual(renewed)
        yield* proxy.complete({
          operationKey: replayed.operationKey,
          attempt: replayed.attempt,
          callId: replayed.callId,
          requestDigest: replayed.requestDigest,
          outcome: { _tag: "Returned", response: { _tag: "Success", output: { resumed: true } } },
        })
        expect(yield* Fiber.join(running)).toEqual({ _tag: "Success", output: { resumed: true } })
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
