import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { foregroundLocalExecutorLayer, runForegroundLocalExecutor } from "../src/foreground"
import type { AccessWire } from "../src/protocol"

class FakeWebSocket {
  static current: FakeWebSocket | undefined
  static readonly instances: Array<FakeWebSocket> = []
  readonly readyState = 1
  readonly sent: Array<unknown> = []
  closed = false
  private readonly listeners = new Map<string, Set<(event: any) => void>>()

  constructor(_url: string) {
    FakeWebSocket.current = this
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const current = this.listeners.get(type) ?? new Set()
    current.add(listener)
    this.listeners.set(type, current)
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener)
  }

  send(value: string) {
    this.sent.push(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(value))
  }

  close() {
    this.closed = true
    this.emit("close", { code: 1000, reason: "test complete" })
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  message(value: unknown) {
    this.emit("message", { data: Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(value) })
  }
}

class EventuallyTimeout extends Schema.TaggedError<EventuallyTimeout>()("EventuallyTimeout", {
  message: Schema.String,
}) {}

const eventually = <A>(read: () => A | undefined): Effect.Effect<A, EventuallyTimeout> =>
  Effect.suspend(() => {
    const value = read()
    return value === undefined ? Effect.yieldNow.pipe(Effect.andThen(eventually(read))) : Effect.succeed(value)
  }).pipe(
    Effect.timeoutOrElse({
      duration: "1 second",
      orElse: () => Effect.fail(EventuallyTimeout.make({ message: "timed out" })),
    }),
  )

describe.sequential("foreground local executor", () => {
  it.effect("uses only a local admission and replays cell results in memory", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const original = globalThis.WebSocket
        ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
        return original
      }),
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const foregroundContext = yield* Layer.build(foregroundLocalExecutorLayer)
            const workspacePath = yield* Effect.promise(() =>
              import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/rika-local-executor-")),
            )
            const ready = yield* Deferred.make<void, import("../src/foreground").ForegroundLocalExecutorError>()
            const runner = yield* Effect.forkScoped(
              runForegroundLocalExecutor({
                admission: {
                  admissionId: "admission-1",
                  ticket: "one-use-ticket",
                  executorUrl: "wss://controller.example.test/api/v1/local-executors",
                  workspaceIdentity: "workspace-binding-1",
                  expiresAt: 9_999_999_999_999,
                },
                workspacePath,
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const socket = yield* eventually(() => FakeWebSocket.current)
            const hello = yield* eventually(
              () => socket.sent.find((message: any) => message._tag === "LocalExecutorHello") as any,
            )
            expect(hello).toEqual({
              _tag: "LocalExecutorHello",
              hello: {
                admissionId: "admission-1",
                ticket: "one-use-ticket",
                processIncarnation: expect.any(String),
                capabilities: { cells: true, checkpoints: false, pty: false },
                cursors: { command: 0, event: 0, pty: 0 },
              },
            })
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "local_device",
                assignmentId: "assignment-1",
                assignmentGeneration: 1,
                instanceId: "device-1",
                executorId: "executor-1",
                processIncarnation: (hello as any).hello.processIncarnation,
              },
              leaseEpoch: 1,
              sessionToken: "session-1",
            }
            socket.message({
              _tag: "ExecutorWelcome",
              welcome: {
                version: 1,
                fence: access.fence,
                leaseEpoch: 1,
                sessionToken: "session-1",
                leaseExpiresAt: 10_000,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            socket.message({
              _tag: "CellExecute",
              request: {
                access,
                operationKey: "operation-mismatch",
                workspace: "another-workspace-binding",
                sessionId: "session-1",
                toolCallId: "call-mismatch",
                code: 'printf "must-not-run"',
              },
            })
            const mismatch = yield* eventually(
              () =>
                socket.sent.find(
                  (message: any) => message._tag === "LocalCellResult" && message.operationKey === "operation-mismatch",
                ) as any,
            )
            expect(mismatch.response).toEqual({
              _tag: "DomainFailure",
              failure: { kind: "workspace", message: "Cell workspace does not match this executor" },
            })
            yield* Deferred.await(ready)
            const request = {
              access,
              operationKey: "operation-1",
              workspace: "workspace-binding-1",
              sessionId: "session-1",
              toolCallId: "call-1",
              code: 'printf "$$"',
            }
            socket.message({ _tag: "CellExecute", request })
            const first = yield* eventually(
              () =>
                socket.sent.find(
                  (message: any) => message._tag === "LocalCellResult" && message.operationKey === "operation-1",
                ) as any,
            )
            socket.message({ _tag: "CellExecute", request })
            const results = yield* eventually(() => {
              const values = socket.sent.filter(
                (message: any) => message._tag === "LocalCellResult" && message.operationKey === "operation-1",
              )
              return values.length === 2 ? values : undefined
            })
            expect(results).toEqual([
              {
                _tag: "LocalCellResult",
                access,
                operationKey: "operation-1",
                attempt: 0,
                response: first.response,
              },
              {
                _tag: "LocalCellResult",
                access,
                operationKey: "operation-1",
                attempt: 0,
                response: first.response,
              },
            ])
            expect(
              yield* Effect.promise(() => import("node:fs/promises").then((fs) => fs.readdir(workspacePath))),
            ).toEqual([])
            yield* Fiber.interrupt(runner)
            expect(yield* eventually(() => (socket.closed ? true : undefined))).toBe(true)
          }),
        ),
      (original) =>
        Effect.sync(() => {
          ;(globalThis as { WebSocket: unknown }).WebSocket = original
          FakeWebSocket.current = undefined
          FakeWebSocket.instances.length = 0
        }),
    ),
  )

  it.effect("reconnects with the same fence and resends an unacknowledged result", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const original = globalThis.WebSocket
        ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
        return original
      }),
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const foregroundContext = yield* Layer.build(foregroundLocalExecutorLayer)
            const ready = yield* Deferred.make<void, import("../src/foreground").ForegroundLocalExecutorError>()
            const runner = yield* Effect.forkScoped(
              runForegroundLocalExecutor({
                admission: {
                  admissionId: "admission-1",
                  ticket: "one-use-ticket",
                  executorUrl: "wss://controller.example.test/api/v1/local-executors",
                  workspaceIdentity: "workspace-binding-1",
                  expiresAt: 9_999_999_999_999,
                },
                workspacePath: "/tmp",
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const socket = yield* eventually(() => FakeWebSocket.instances[0])
            const hello = yield* eventually(
              () => socket.sent.find((message: any) => message._tag === "LocalExecutorHello") as any,
            )
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "local_device",
                assignmentId: "assignment-reconnect",
                assignmentGeneration: 1,
                instanceId: "device-1",
                executorId: "executor-1",
                processIncarnation: hello.hello.processIncarnation,
              },
              leaseEpoch: 1,
              sessionToken: "session-1",
            }
            socket.message({
              _tag: "ExecutorWelcome",
              welcome: {
                version: 1,
                fence: access.fence,
                leaseEpoch: 1,
                sessionToken: access.sessionToken,
                leaseExpiresAt: 10_000,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            yield* Deferred.await(ready)
            socket.message({
              _tag: "CellExecute",
              request: {
                access,
                operationKey: "operation-reconnect",
                workspace: "workspace-binding-1",
                sessionId: "session-1",
                toolCallId: "call-1",
                code: 'printf "reconnect"',
              },
            })
            yield* Effect.yieldNow
            socket.close()
            for (let index = 0; index < 10; index += 1) {
              yield* Effect.yieldNow
              yield* TestClock.adjust("250 millis")
            }
            const reconnectedSocket = yield* eventually(() => FakeWebSocket.instances[1])
            const reconnect = yield* eventually(
              () => reconnectedSocket.sent.find((message: any) => message._tag === "ExecutorReconnect") as any,
            )
            expect(reconnect.access.fence).toEqual(access.fence)
            const renewed: AccessWire = { ...access, leaseEpoch: 2 }
            reconnectedSocket.message({
              _tag: "ExecutorReconnected",
              welcome: {
                version: 1,
                fence: renewed.fence,
                leaseEpoch: 2,
                leaseExpiresAt: 10_000,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            const resent = yield* eventually(
              () =>
                reconnectedSocket.sent.find(
                  (message: any) => message._tag === "LocalCellResult" && message.operationKey === "operation-reconnect",
                ) as any,
            )
            expect(resent.access).toEqual(renewed)
            reconnectedSocket.message({
              _tag: "LocalCellReceipt",
              access: renewed,
              operationKey: "operation-reconnect",
              attempt: 0,
            })
            yield* Fiber.interrupt(runner)
          }),
        ),
      (original) =>
        Effect.sync(() => {
          ;(globalThis as { WebSocket: unknown }).WebSocket = original
          FakeWebSocket.current = undefined
          FakeWebSocket.instances.length = 0
        }),
    ),
  )

  it.effect("resumes a persisted running receipt as unknown without replaying local code", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const original = globalThis.WebSocket
        ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
        return original
      }),
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const foregroundContext = yield* Layer.build(foregroundLocalExecutorLayer)
            let latestSnapshot: import("../src/foreground").ForegroundLocalExecutorSnapshot | undefined
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "local_device",
                assignmentId: "assignment-resume",
                assignmentGeneration: 1,
                instanceId: "device-1",
                executorId: "executor-1",
                processIncarnation: "process-1",
              },
              leaseEpoch: 1,
              sessionToken: "session-1",
            }
            const ready = yield* Deferred.make<void, import("../src/foreground").ForegroundLocalExecutorError>()
            const runner = yield* Effect.forkScoped(
              runForegroundLocalExecutor({
                resume: {
                  version: 1,
                  workspaceIdentity: "workspace-binding-1",
                  executorUrl: "wss://controller.example.test/api/v1/local-executors",
                  access,
                  leaseExpiresAt: 10_000,
                  heartbeatIntervalMillis: 60_000,
                  cursor: { sequence: 0, value: "" },
                  receipts: [{
                    operationKey: "operation-resume",
                    attempt: 0,
                    state: "running",
                  }],
                },
                workspacePath: "/tmp",
                receiptScope: "resume-scope",
                receiptStore: {
                  save: (_scope, snapshot) => Effect.sync(() => {
                    latestSnapshot = snapshot
                  }),
                },
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const socket = yield* eventually(() => FakeWebSocket.instances[0])
            const reconnect = yield* eventually(
              () => socket.sent.find((message: any) => message._tag === "ExecutorReconnect") as any,
            )
            expect(reconnect.access).toEqual(access)
            const renewed = { ...access, leaseEpoch: 2 }
            socket.message({
              _tag: "ExecutorReconnected",
              welcome: {
                version: 1,
                fence: renewed.fence,
                leaseEpoch: 2,
                leaseExpiresAt: 10_000,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            yield* Deferred.await(ready)
            const result = yield* eventually(
              () =>
                socket.sent.find(
                  (message: any) => message._tag === "LocalCellResult" && message.operationKey === "operation-resume",
                ) as any,
            )
            expect(result.response).toEqual({
              _tag: "DomainFailure",
              failure: { kind: "unknown", message: "Local operation outcome is unknown after foreground restart" },
            })
            socket.message({
              _tag: "LocalCellReceipt",
              access: renewed,
              operationKey: "operation-resume",
              attempt: 0,
            })
            const latest = yield* eventually(() =>
              latestSnapshot?.receipts.length === 0 ? latestSnapshot : undefined,
            )
            expect(latest.receipts).toEqual([])
            yield* Fiber.interrupt(runner)
          }),
        ),
      (original) =>
        Effect.sync(() => {
          ;(globalThis as { WebSocket: unknown }).WebSocket = original
          FakeWebSocket.current = undefined
          FakeWebSocket.instances.length = 0
        }),
    ),
  )

  it.effect("sends goodbye on shutdown and keeps unacknowledged receipts until the controller receipts them", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const original = globalThis.WebSocket
        ;(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket
        return original
      }),
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const foregroundContext = yield* Layer.build(foregroundLocalExecutorLayer)
            let latestSnapshot: import("../src/foreground").ForegroundLocalExecutorSnapshot | undefined
            const ready = yield* Deferred.make<void, import("../src/foreground").ForegroundLocalExecutorError>()
            const runner = yield* Effect.forkScoped(
              runForegroundLocalExecutor({
                admission: {
                  admissionId: "admission-1",
                  ticket: "one-use-ticket",
                  executorUrl: "wss://controller.example.test/api/v1/local-executors",
                  workspaceIdentity: "workspace-binding-1",
                  expiresAt: 9_999_999_999_999,
                },
                workspacePath: "/tmp",
                receiptScope: "goodbye-scope",
                receiptStore: {
                  save: (_scope, snapshot) =>
                    Effect.sync(() => {
                      latestSnapshot = snapshot
                    }),
                },
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const firstSocket = yield* eventually(() => FakeWebSocket.instances[0])
            const hello = yield* eventually(
              () => firstSocket.sent.find((message: any) => message._tag === "LocalExecutorHello") as any,
            )
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "local_device",
                assignmentId: "assignment-goodbye",
                assignmentGeneration: 1,
                instanceId: "device-1",
                executorId: "executor-1",
                processIncarnation: hello.hello.processIncarnation,
              },
              leaseEpoch: 1,
              sessionToken: "session-1",
            }
            firstSocket.message({
              _tag: "ExecutorWelcome",
              welcome: {
                version: 1,
                fence: access.fence,
                leaseEpoch: 1,
                sessionToken: access.sessionToken,
                leaseExpiresAt: 10_000,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            yield* Deferred.await(ready)
            firstSocket.message({
              _tag: "CellExecute",
              request: {
                access,
                operationKey: "operation-goodbye",
                workspace: "workspace-binding-1",
                sessionId: "session-1",
                toolCallId: "call-1",
                code: 'printf "goodbye"',
              },
            })
            const completed = yield* eventually(
              () =>
                firstSocket.sent.find(
                  (message: any) => message._tag === "LocalCellResult" && message.operationKey === "operation-goodbye",
                ) as any,
            )
            const pending = yield* eventually(() =>
              latestSnapshot !== undefined &&
              latestSnapshot.receipts.some((receipt) => receipt.operationKey === "operation-goodbye")
                ? latestSnapshot
                : undefined,
            )
            expect(pending.receipts).toEqual([
              {
                operationKey: "operation-goodbye",
                attempt: 0,
                state: "completed",
                response: completed.response,
              },
            ])
            firstSocket.close()
            for (let index = 0; index < 10; index += 1) {
              yield* Effect.yieldNow
              yield* TestClock.adjust("250 millis")
            }
            const reconnectedSocket = yield* eventually(() => FakeWebSocket.instances[1])
            yield* eventually(() => reconnectedSocket.sent.find((message: any) => message._tag === "ExecutorReconnect"))
            reconnectedSocket.message({
              _tag: "ExecutorReconnected",
              welcome: {
                version: 1,
                fence: access.fence,
                leaseEpoch: 1,
                leaseExpiresAt: 10_000,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            yield* eventually(
              () =>
                reconnectedSocket.sent.find(
                  (message: any) => message._tag === "LocalCellResult" && message.operationKey === "operation-goodbye",
                ) as any,
            )
            expect(latestSnapshot?.receipts).toEqual([
              {
                operationKey: "operation-goodbye",
                attempt: 0,
                state: "completed",
                response: completed.response,
              },
            ])
            reconnectedSocket.message({
              _tag: "LocalCellReceipt",
              access,
              operationKey: "operation-goodbye",
              attempt: 0,
            })
            expect(
              (
                yield* eventually(() =>
                  latestSnapshot !== undefined && latestSnapshot.receipts.length === 0 ? latestSnapshot : undefined,
                )
              ).receipts,
            ).toEqual([])
            yield* Fiber.interrupt(runner)
            expect(
              yield* eventually(() =>
                reconnectedSocket.sent.find((message: any) => message._tag === "LocalExecutorGoodbye") === undefined
                  ? undefined
                  : true,
              ),
            ).toBe(true)
          }),
        ),
      (original) =>
        Effect.sync(() => {
          ;(globalThis as { WebSocket: unknown }).WebSocket = original
          FakeWebSocket.current = undefined
          FakeWebSocket.instances.length = 0
        }),
    ),
  )

  it.effect("rejects a non-WSS local executor URL before it can connect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const foregroundContext = yield* Layer.build(foregroundLocalExecutorLayer)
        const exit = yield* Effect.exit(
          runForegroundLocalExecutor({
            admission: {
              admissionId: "admission-1",
              ticket: "one-use-ticket",
              executorUrl: "ws://controller.example.test/api/v1/local-executors",
              workspaceIdentity: "workspace-binding-1",
              expiresAt: 9_999_999_999_999,
            },
            workspacePath: "/not-used",
          }).pipe(Effect.provide(foregroundContext)),
        )
        expect(exit._tag).toBe("Failure")
        expect(String(exit)).toContain("wss")
      }),
    ),
  )
})
