import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import { describe, expect, it } from "@effect/vitest"
import { Context, Crypto, Effect, Fiber, Layer, Schema } from "effect"
import * as BindingProxy from "../src/binding-proxy"
import { bindingManifest, type CellRequest } from "../src/protocol"

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
          deadline: null,
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
          deadline: null,
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
})
