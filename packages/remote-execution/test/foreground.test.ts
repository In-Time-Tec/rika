import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { foregroundRunnerLayer, runForegroundRunner } from "../src/foreground"
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

const terminal = (socket: FakeWebSocket, operationKey: string, occurrence = 0) =>
  eventually(
    () =>
      socket.sent.filter(
        (message: any) =>
          message._tag === "CellLifecycle" &&
          message.frame._tag === "Terminal" &&
          message.frame.attribution.operationKey === operationKey,
      )[occurrence] as any,
  )

const acknowledgeTerminal = (socket: FakeWebSocket, access: AccessWire, operationKey: string, occurrence = 0) =>
  Effect.gen(function* () {
    const message = yield* terminal(socket, operationKey, occurrence)
    socket.message({
      _tag: "CellTerminalReceipt",
      access,
      operationKey,
      attempt: message.frame.attribution.attempt,
      cursor: message.frame.cursor,
    })
    return message
  })

const bindings = {
  digest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  descriptors: [],
} as const

describe.sequential("foreground Runner", () => {
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
            const foregroundContext = yield* Layer.build(foregroundRunnerLayer)
            const workspacePath = yield* Effect.promise(() =>
              import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/rika-runner-")),
            )
            const ready = yield* Deferred.make<void, import("../src/foreground").ForegroundRunnerError>()
            const runner = yield* Effect.forkScoped(
              runForegroundRunner({
                admission: {
                  admissionId: "admission-1",
                  ticket: "one-use-ticket",
                  executorUrl: "wss://controller.example.test/api/v1/runners",
                  workspaceIdentity: "workspace-binding-1",
                  expiresAt: 9_999_999_999_999,
                },
                workspacePath,
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const socket = yield* eventually(() => FakeWebSocket.current)
            const hello = yield* eventually(
              () => socket.sent.find((message: any) => message._tag === "RunnerHello") as any,
            )
            expect(hello).toEqual({
              _tag: "RunnerHello",
              hello: {
                admissionId: "admission-1",
                ticket: "one-use-ticket",
                processIncarnation: expect.any(String),
                capabilities: { cells: true, checkpoints: false, pty: false },
                workspaceCapabilities: expect.objectContaining({
                  environmentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
                  typescriptKernel: { _tag: "Ready", detail: "persistent Bun TypeScript kernel available" },
                }),
                cursors: { command: 0, event: 0, pty: 0 },
              },
            })
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "runner",
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
                workspaceId: "another-workspace-binding",
                sessionId: "session-1",
                threadId: "thread-1",
                turnId: "turn-1",
                runId: "run-1",
                rootRunId: "run-1",
                toolCallId: "call-mismatch",
                code: 'printf "must-not-run"',
                attempt: 0,
                replayPolicy: "never",
                admittedAt: null,
                deadline: null,
                bindings,
              },
            })
            yield* acknowledgeTerminal(socket, access, "operation-mismatch")
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
              workspaceId: "workspace-binding-1",
              sessionId: "session-1",
              threadId: "thread-1",
              turnId: "turn-1",
              runId: "run-1",
              rootRunId: "run-1",
              toolCallId: "call-1",
              code: "const answer: number = 42; answer",
              attempt: 0,
              replayPolicy: "pure" as const,
              admittedAt: null,
              deadline: null,
              bindings,
            }
            socket.message({ _tag: "CellExecute", request })
            yield* acknowledgeTerminal(socket, access, "operation-1")
            const first = yield* eventually(
              () =>
                socket.sent.find(
                  (message: any) => message._tag === "LocalCellResult" && message.operationKey === "operation-1",
                ) as any,
            )
            expect(first.response._tag).toBe("Success")
            socket.message({ _tag: "CellExecute", request })
            yield* acknowledgeTerminal(socket, access, "operation-1", 1)
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
            const lifecycleReplays = socket.sent
              .filter(
                (message: any) =>
                  message._tag === "CellLifecycle" && message.frame.attribution.operationKey === "operation-1",
              )
              .map((message: any) => message.frame)
            const terminalIndex = lifecycleReplays.findIndex((frame: any) => frame._tag === "Terminal")
            const firstLifecycle = lifecycleReplays.slice(0, terminalIndex + 1)
            expect(firstLifecycle.map((frame: any) => frame.cursor)).toEqual(
              firstLifecycle.map((_: unknown, index: number) => index + 1),
            )
            expect(lifecycleReplays.slice(terminalIndex + 1)).toEqual(firstLifecycle)
            const outputRequest = {
              ...request,
              operationKey: "operation-output",
              toolCallId: "call-output",
              code: `console.log('token="sensitive" ' + 'x'.repeat(20_000))`,
            }
            socket.message({ _tag: "CellExecute", request: outputRequest })
            yield* acknowledgeTerminal(socket, access, "operation-output")
            const output = yield* eventually(
              () =>
                socket.sent.find(
                  (message: any) =>
                    message._tag === "CellLifecycle" &&
                    message.frame._tag === "Output" &&
                    message.frame.attribution.operationKey === "operation-output",
                ) as any,
            )
            expect(output.frame.text).not.toContain("sensitive")
            expect(output.frame.text.length).toBeLessThanOrEqual(16_384)
            expect(output.frame.redacted).toBe(true)
            expect(output.frame.truncated).toBe(true)
            const cancelRequest = {
              ...request,
              operationKey: "operation-cancel",
              toolCallId: "call-cancel",
              code: "await new Promise<void>(() => {})",
            }
            socket.message({ _tag: "CellExecute", request: cancelRequest })
            yield* eventually(
              () =>
                socket.sent.find(
                  (message: any) =>
                    message._tag === "CellLifecycle" &&
                    message.frame._tag === "Started" &&
                    message.frame.attribution.operationKey === "operation-cancel",
                ) as any,
            )
            socket.message({
              _tag: "CellCancel",
              access,
              operationKey: "operation-cancel",
              attempt: 0,
            })
            const cancelled = yield* acknowledgeTerminal(socket, access, "operation-cancel")
            expect(cancelled.frame.outcome).toBe("cancelled")
            expect(cancelled.frame.response).toEqual({
              _tag: "DomainFailure",
              failure: { kind: "cancelled", message: "Cell operation cancelled" },
            })
            expect(
              socket.sent.filter(
                (message: any) =>
                  message._tag === "CellLifecycle" &&
                  message.frame._tag === "Terminal" &&
                  message.frame.attribution.operationKey === "operation-cancel",
              ),
            ).toHaveLength(1)
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
            const foregroundContext = yield* Layer.build(foregroundRunnerLayer)
            const ready = yield* Deferred.make<void, import("../src/foreground").ForegroundRunnerError>()
            const runner = yield* Effect.forkScoped(
              runForegroundRunner({
                admission: {
                  admissionId: "admission-1",
                  ticket: "one-use-ticket",
                  executorUrl: "wss://controller.example.test/api/v1/runners",
                  workspaceIdentity: "workspace-binding-1",
                  expiresAt: 9_999_999_999_999,
                },
                workspacePath: "/tmp",
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const socket = yield* eventually(() => FakeWebSocket.instances[0])
            const hello = yield* eventually(
              () => socket.sent.find((message: any) => message._tag === "RunnerHello") as any,
            )
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "runner",
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
            const reconnectRequest = {
              access,
              operationKey: "operation-reconnect",
              workspaceId: "workspace-binding-1",
              sessionId: "session-1",
              threadId: "thread-1",
              turnId: "turn-1",
              runId: "run-1",
              rootRunId: "run-1",
              toolCallId: "call-1",
              code: "globalThis.__rikaReconnectIdentity = (globalThis.__rikaReconnectIdentity ?? 0) + 1",
              attempt: 0,
              replayPolicy: "pure",
              admittedAt: null,
              deadline: null,
              bindings,
            }
            socket.message({ _tag: "CellExecute", request: reconnectRequest })
            const initialTerminal = yield* terminal(socket, "operation-reconnect")
            expect(initialTerminal.frame.response).toMatchObject({ _tag: "Success" })
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
            reconnectedSocket.message({
              _tag: "CellReplay",
              access: renewed,
              operationKey: "operation-reconnect",
              attempt: 0,
              afterCursor: 0,
            })
            yield* acknowledgeTerminal(reconnectedSocket, renewed, "operation-reconnect")
            const resent = yield* eventually(
              () =>
                reconnectedSocket.sent.find(
                  (message: any) =>
                    message._tag === "LocalCellResult" && message.operationKey === "operation-reconnect",
                ) as any,
            )
            expect(resent.access).toEqual(renewed)
            reconnectedSocket.message({
              _tag: "LocalCellReceipt",
              access: renewed,
              operationKey: "operation-reconnect",
              attempt: 0,
            })
            reconnectedSocket.message({
              _tag: "CellExecute",
              request: {
                ...reconnectRequest,
                access: renewed,
                operationKey: "operation-after-reconnect",
                toolCallId: "call-after-reconnect",
                code: "globalThis.__rikaReconnectIdentity",
              },
            })
            yield* acknowledgeTerminal(reconnectedSocket, renewed, "operation-after-reconnect")
            const afterReconnect = yield* eventually(
              () =>
                reconnectedSocket.sent.find(
                  (message: any) =>
                    message._tag === "LocalCellResult" && message.operationKey === "operation-after-reconnect",
                ) as any,
            )
            expect(afterReconnect.response).toMatchObject({
              _tag: "Success",
              result: { value: initialTerminal.frame.response.result.value },
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
            const foregroundContext = yield* Layer.build(foregroundRunnerLayer)
            let latestSnapshot: import("../src/foreground").ForegroundRunnerSnapshot | undefined
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "runner",
                assignmentId: "assignment-resume",
                assignmentGeneration: 1,
                instanceId: "device-1",
                executorId: "executor-1",
                processIncarnation: "process-1",
              },
              leaseEpoch: 1,
              sessionToken: "session-1",
            }
            const ready = yield* Deferred.make<void, import("../src/foreground").ForegroundRunnerError>()
            const runner = yield* Effect.forkScoped(
              runForegroundRunner({
                resume: {
                  version: 1,
                  workspaceIdentity: "workspace-binding-1",
                  executorUrl: "wss://controller.example.test/api/v1/runners",
                  access,
                  leaseExpiresAt: 10_000,
                  heartbeatIntervalMillis: 60_000,
                  cursor: { sequence: 0, value: "" },
                  machines: [],
                  receipts: [
                    {
                      operationKey: "operation-resume",
                      attempt: 0,
                      attribution: {
                        operationKey: "operation-resume",
                        workspaceId: "workspace-binding-1",
                        sessionId: "cell-session-resume",
                        threadId: "thread-resume",
                        turnId: "turn-resume",
                        runId: "run-resume",
                        rootRunId: "run-resume",
                        toolCallId: "tool-call-resume",
                        attempt: 0,
                      },
                      frames: [],
                      state: "running",
                    },
                  ],
                },
                workspacePath: "/tmp",
                receiptScope: "resume-scope",
                receiptStore: {
                  save: (_scope, snapshot) =>
                    Effect.sync(() => {
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
            socket.message({
              _tag: "CellExecute",
              request: {
                access: renewed,
                operationKey: "operation-resume",
                workspaceId: "workspace-binding-1",
                sessionId: "cell-session-resume",
                threadId: "thread-resume",
                turnId: "turn-resume",
                runId: "run-resume",
                rootRunId: "run-resume",
                toolCallId: "tool-call-resume",
                code: "mustNotRun()",
                attempt: 0,
                replayPolicy: "never",
                admittedAt: null,
                deadline: null,
                bindings,
              },
            })
            yield* acknowledgeTerminal(socket, renewed, "operation-resume")
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
            const latest = yield* eventually(() => (latestSnapshot?.receipts.length === 0 ? latestSnapshot : undefined))
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
            const foregroundContext = yield* Layer.build(foregroundRunnerLayer)
            let latestSnapshot: import("../src/foreground").ForegroundRunnerSnapshot | undefined
            const ready = yield* Deferred.make<void, import("../src/foreground").ForegroundRunnerError>()
            const runner = yield* Effect.forkScoped(
              runForegroundRunner({
                admission: {
                  admissionId: "admission-1",
                  ticket: "one-use-ticket",
                  executorUrl: "wss://controller.example.test/api/v1/runners",
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
              () => firstSocket.sent.find((message: any) => message._tag === "RunnerHello") as any,
            )
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "runner",
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
                workspaceId: "workspace-binding-1",
                sessionId: "session-1",
                threadId: "thread-1",
                turnId: "turn-1",
                runId: "run-1",
                rootRunId: "run-1",
                toolCallId: "call-1",
                code: 'printf "goodbye"',
                attempt: 0,
                replayPolicy: "pure",
                admittedAt: null,
                deadline: null,
                bindings,
              },
            })
            const firstTerminal = yield* acknowledgeTerminal(firstSocket, access, "operation-goodbye")
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
              expect.objectContaining({
                operationKey: "operation-goodbye",
                attempt: 0,
                state: "completed",
                response: completed.response,
                attribution: firstTerminal.frame.attribution,
              }),
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
            reconnectedSocket.message({
              _tag: "CellReplay",
              access,
              operationKey: "operation-goodbye",
              attempt: 0,
              afterCursor: 0,
            })
            yield* acknowledgeTerminal(reconnectedSocket, access, "operation-goodbye")
            yield* eventually(
              () =>
                reconnectedSocket.sent.find(
                  (message: any) => message._tag === "LocalCellResult" && message.operationKey === "operation-goodbye",
                ) as any,
            )
            expect(latestSnapshot?.receipts).toEqual([
              expect.objectContaining({
                operationKey: "operation-goodbye",
                attempt: 0,
                state: "completed",
                response: completed.response,
                attribution: firstTerminal.frame.attribution,
              }),
            ])
            reconnectedSocket.message({
              _tag: "LocalCellReceipt",
              access,
              operationKey: "operation-goodbye",
              attempt: 0,
            })
            expect(
              (yield* eventually(() =>
                latestSnapshot !== undefined && latestSnapshot.receipts.length === 0 ? latestSnapshot : undefined,
              )).receipts,
            ).toEqual([])
            yield* Fiber.interrupt(runner)
            expect(
              yield* eventually(() =>
                reconnectedSocket.sent.find((message: any) => message._tag === "RunnerGoodbye") === undefined
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

  it.effect("rejects a non-WSS Runner URL before it can connect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const foregroundContext = yield* Layer.build(foregroundRunnerLayer)
        const exit = yield* Effect.exit(
          runForegroundRunner({
            admission: {
              admissionId: "admission-1",
              ticket: "one-use-ticket",
              executorUrl: "ws://controller.example.test/api/v1/runners",
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
