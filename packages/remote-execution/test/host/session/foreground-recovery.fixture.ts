import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { foregroundRunnerLayer, runForegroundRunner } from "../../../src/host/session/foreground"
import { ForegroundSession } from "../../../src/host/session/foreground-session"
import {
  ApiMessage,
  RunnerMessage,
  type AccessWire,
  type ApiMessage as ApiMessageValue,
  type CellLifecycleFrame,
  type RunnerMessage as RunnerMessageValue,
} from "../../../src/protocol/messages"

const hasTag =
  <Tag extends RunnerMessageValue["_tag"]>(tag: Tag) =>
  (message: RunnerMessageValue): message is Extract<RunnerMessageValue, { readonly _tag: Tag }> =>
    message._tag === tag

type CellLifecycleMessage = Extract<RunnerMessageValue, { readonly _tag: "CellLifecycle" }>

const hasFrameTag =
  <Tag extends CellLifecycleFrame["_tag"]>(tag: Tag) =>
  (
    message: CellLifecycleMessage,
  ): message is CellLifecycleMessage & { readonly frame: Extract<CellLifecycleFrame, { readonly _tag: Tag }> } =>
    message.frame._tag === tag

class FakeWebSocket {
  static current: FakeWebSocket | undefined
  static readonly instances: Array<FakeWebSocket> = []
  static onSend: ((socket: FakeWebSocket, message: RunnerMessageValue) => void) | undefined
  static failedOpens = 0
  readonly readyState: number
  readonly sent: Array<RunnerMessageValue> = []
  closed = false
  private readonly failOpen: boolean
  private readonly listeners = new Map<string, Set<EventListener>>()

  constructor(_url: string) {
    this.failOpen = FakeWebSocket.failedOpens > 0
    this.readyState = this.failOpen ? 0 : 1
    if (this.failOpen) FakeWebSocket.failedOpens -= 1
    FakeWebSocket.current = this
    FakeWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener) {
    const current = this.listeners.get(type) ?? new Set()
    current.add(listener)
    this.listeners.set(type, current)
  }

  removeEventListener(type: string, listener: EventListener) {
    this.listeners.get(type)?.delete(listener)
  }

  send(value: string) {
    const message = Schema.decodeSync(Schema.fromJsonString(RunnerMessage))(value)
    this.sent.push(message)
    FakeWebSocket.onSend?.(this, message)
  }

  close() {
    this.closed = true
    this.emit("close", new CloseEvent("close", { code: 1000, reason: "test complete" }))
  }

  emit(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  listensFor(type: string) {
    return (this.listeners.get(type)?.size ?? 0) > 0
  }

  failOpening() {
    this.emit("error", new Event("error"))
  }

  message(value: ApiMessageValue) {
    const data = Schema.encodeSync(Schema.fromJsonString(ApiMessage))(value)
    this.emit("message", new MessageEvent<string>("message", { data }))
  }

  messages<Tag extends RunnerMessageValue["_tag"]>(tag: Tag) {
    return this.sent.filter(hasTag(tag))
  }

  frames<Tag extends CellLifecycleFrame["_tag"]>(tag: Tag) {
    return this.messages("CellLifecycle").filter(hasFrameTag(tag))
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

const _eventuallyLive = <A>(read: () => A | undefined): Effect.Effect<A, EventuallyTimeout> =>
  Effect.suspend(() => {
    const value = read()
    return value === undefined
      ? Effect.sleep("10 millis").pipe(Effect.andThen(_eventuallyLive(read)))
      : Effect.succeed(value)
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(EventuallyTimeout.make({ message: "timed out" })),
    }),
  )

const terminal = (socket: FakeWebSocket, operationKey: string, occurrence = 0) =>
  eventually(
    () =>
      socket.frames("Terminal").filter((message) => message.frame.attribution.operationKey === operationKey)[
        occurrence
      ],
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

const _CellFailureWire = Schema.Struct({
  kind: Schema.Literals(["cancelled", "timeout", "workspace"]),
  message: Schema.String,
})

const _CellSuccessValue = Schema.TaggedStruct("Success", {
  result: Schema.Struct({ value: Schema.Json }),
})

describe("foreground Runner", { concurrent: false }, () => {
  it.effect("cancels persisted Running authority after restart without replaying local code", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const original = globalThis.WebSocket
        Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket, writable: true })
        return original
      }),
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const foregroundContext = yield* Layer.build(foregroundRunnerLayer)
            let latestSnapshot: import("../../../src/host/session/foreground").ForegroundRunnerSnapshot | undefined
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
            const ready = yield* Deferred.make<
              void,
              import("../../../src/host/session/foreground").ForegroundRunnerError
            >()
            const runner = yield* Effect.forkScoped(
              runForegroundRunner({
                resume: {
                  version: 1,
                  workspaceIdentity: "workspace-binding-1",
                  executorUrl: "wss://controller.example.test/api/v1/runners",
                  access,
                  leaseExpiresAt: 120_000,
                  heartbeatIntervalMillis: 60_000,
                  cursor: { sequence: 0, value: "" },
                  cells: [
                    {
                      executionKey: "operation-resume\u00000",
                      state: { _tag: "Running", attempt: 0 },
                    },
                  ],
                  machines: [],
                  receipts: [
                    {
                      operationKey: "operation-resume",
                      frames: [
                        {
                          _tag: "Accepted",
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
                          cursor: 1,
                        },
                      ],
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
            const reconnect = yield* eventually(() => socket.messages("ExecutorReconnect")[0])
            expect(reconnect.access).toEqual(access)
            const renewed = { ...access, leaseEpoch: 2 }
            socket.message({
              _tag: "ExecutorReconnected",
              welcome: {
                version: 1,
                fence: renewed.fence,
                leaseEpoch: 2,
                leaseExpiresAt: 120_000,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            yield* Deferred.await(ready)
            socket.message({
              _tag: "CellCancel",
              access: renewed,
              operationKey: "operation-resume",
              attempt: 0,
            })
            const cancelled = yield* acknowledgeTerminal(socket, renewed, "operation-resume")
            expect(cancelled.frame.response).toEqual({
              _tag: "DomainFailure",
              failure: { kind: "cancelled", message: "Cell operation cancelled" },
            })
            expect(cancelled.frame.outcome).toBe("cancelled")
            const result = yield* eventually(() =>
              socket.messages("LocalCellResult").find((message) => message.operationKey === "operation-resume"),
            )
            expect(result.response).toEqual({
              _tag: "DomainFailure",
              failure: { kind: "cancelled", message: "Cell operation cancelled" },
            })
            const completed = yield* eventually(() =>
              latestSnapshot?.cells.find((cell) => cell.executionKey === "operation-resume\u00000")?.state._tag ===
              "Completed"
                ? latestSnapshot
                : undefined,
            )
            expect(completed.cells).toEqual([
              {
                executionKey: "operation-resume\u00000",
                state: { _tag: "Completed", attempt: 0, response: result.response },
              },
            ])
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
          Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original, writable: true })
          FakeWebSocket.current = undefined
          FakeWebSocket.instances.length = 0
          FakeWebSocket.onSend = undefined
        }),
    ),
  )

  it.effect("closes the socket on shutdown and keeps unacknowledged receipts until the controller receipts them", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const original = globalThis.WebSocket
        Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket, writable: true })
        return original
      }),
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const foregroundContext = yield* Layer.build(foregroundRunnerLayer)
            let latestSnapshot: import("../../../src/host/session/foreground").ForegroundRunnerSnapshot | undefined
            const ready = yield* Deferred.make<
              void,
              import("../../../src/host/session/foreground").ForegroundRunnerError
            >()
            const runner = yield* Effect.forkScoped(
              runForegroundRunner({
                admission: {
                  assignmentId: "assignment-1",
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
            const hello = yield* eventually(() => firstSocket.messages("RunnerHello")[0])
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
                leaseExpiresAt: 120_000,
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
                deadlineAt: "2999-01-01T00:00:00.000Z",
                bindings,
              },
            })
            const firstTerminal = yield* acknowledgeTerminal(firstSocket, access, "operation-goodbye")
            const completed = yield* eventually(() =>
              firstSocket.messages("LocalCellResult").find((message) => message.operationKey === "operation-goodbye"),
            )
            const pending = yield* eventually(() =>
              latestSnapshot !== undefined &&
              latestSnapshot.receipts.some((receipt) => receipt.operationKey === "operation-goodbye")
                ? latestSnapshot
                : undefined,
            )
            expect(pending.receipts).toHaveLength(1)
            expect(pending.receipts[0]?.operationKey).toBe("operation-goodbye")
            expect(pending.receipts[0]?.frames.at(-1)).toEqual(firstTerminal.frame)
            expect(firstTerminal.frame.response).toEqual(completed.response)
            firstSocket.close()
            for (let index = 0; index < 10; index += 1) {
              yield* Effect.yieldNow
              yield* TestClock.adjust("250 millis")
            }
            const reconnectedSocket = yield* eventually(() => FakeWebSocket.instances[1])
            yield* eventually(() => reconnectedSocket.messages("ExecutorReconnect")[0])
            reconnectedSocket.message({
              _tag: "ExecutorReconnected",
              welcome: {
                version: 1,
                fence: access.fence,
                leaseEpoch: 1,
                leaseExpiresAt: 120_000,
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
            yield* eventually(() =>
              reconnectedSocket
                .messages("LocalCellResult")
                .find((message) => message.operationKey === "operation-goodbye"),
            )
            expect(latestSnapshot?.receipts).toHaveLength(1)
            expect(latestSnapshot?.receipts[0]?.operationKey).toBe("operation-goodbye")
            expect(latestSnapshot?.receipts[0]?.frames.at(-1)).toEqual(firstTerminal.frame)
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
            expect(reconnectedSocket.closed).toBe(true)
          }),
        ),
      (original) =>
        Effect.sync(() => {
          Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original, writable: true })
          FakeWebSocket.current = undefined
          FakeWebSocket.instances.length = 0
        }),
    ),
  )

  it.effect("allows an exact trusted HTTP origin to use its local WebSocket endpoint", () =>
    Effect.gen(function* () {
      expect(
        yield* ForegroundSession.runnerUrl(
          "ws://localhost:3000/api/v1/runners",
          9_999_999_999_999,
          "http://localhost:3000",
        ),
      ).toBe("ws://localhost:3000/api/v1/runners")
    }),
  )

  it.effect("rejects a non-WSS Runner URL before it can connect", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const foregroundContext = yield* Layer.build(foregroundRunnerLayer)
        const exit = yield* Effect.exit(
          runForegroundRunner({
            admission: {
              assignmentId: "assignment-1",
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
