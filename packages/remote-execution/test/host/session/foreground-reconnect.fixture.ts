import { describe, expect, it } from "@effect/vitest"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Deferred, Effect, Fiber, FileSystem, Layer, Queue, Schema } from "effect"
import { TestClock } from "effect/testing"
import { foregroundRunnerLayer, runForegroundRunner } from "../../../src/host/session/foreground"
import {
  ApiMessage,
  RunnerMessage,
  bindingManifest,
  type AccessWire,
  type ApiMessage as ApiMessageValue,
  type CellLifecycleFrame,
  type RunnerMessage as RunnerMessageValue,
} from "../../../src/protocol/messages"
import { provideLayer } from "../../support/layer"

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

const eventuallyLive = <A>(read: () => A | undefined): Effect.Effect<A, EventuallyTimeout> =>
  Effect.suspend(() => {
    const value = read()
    return value === undefined
      ? Effect.sleep("10 millis").pipe(Effect.andThen(eventuallyLive(read)))
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

const CellSuccessValue = Schema.TaggedStruct("Success", {
  result: Schema.Struct({ value: Schema.Json }),
})

describe("foreground Runner", { concurrent: false }, () => {
  it.live("completes concurrent workspace bindings", () =>
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
            const fileSystem = yield* FileSystem.FileSystem
            const workspacePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-bindings-" })
            const ready = yield* Deferred.make<
              void,
              import("../../../src/host/session/foreground").ForegroundRunnerError
            >()
            const runner = yield* Effect.forkScoped(
              runForegroundRunner({
                admission: {
                  assignmentId: "assignment-concurrent-bindings",
                  admissionId: "admission-concurrent-bindings",
                  ticket: "one-use-ticket",
                  executorUrl: "wss://controller.example.test/api/v1/runners",
                  workspaceIdentity: "workspace-concurrent-bindings",
                  expiresAt: 9_999_999_999_999,
                },
                workspacePath,
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const socket = yield* eventuallyLive(() => FakeWebSocket.current)
            const hello = yield* eventuallyLive(() => socket.messages("RunnerHello")[0])
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "runner",
                assignmentId: "assignment-concurrent-bindings",
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
                leaseEpoch: access.leaseEpoch,
                sessionToken: access.sessionToken,
                leaseExpiresAt: 9_999_999_999_999,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            yield* Deferred.await(ready)
            const manifest = yield* bindingManifest([
              { module: "context", operations: ["current"] },
              { module: "workspace", operations: ["read"] },
            ]).pipe(Effect.provide(foregroundContext))
            const bindingCalls: Array<Extract<RunnerMessageValue, { readonly _tag: "BindingInvoke" }>> = []
            const bindingQueue =
              yield* Queue.unbounded<Extract<RunnerMessageValue, { readonly _tag: "BindingInvoke" }>>()
            FakeWebSocket.onSend = (_target, message) => {
              if (message._tag !== "BindingInvoke" || message.operationKey !== "operation-concurrent-bindings") return
              bindingCalls.push(message)
              Queue.offerUnsafe(bindingQueue, message)
            }
            yield* Effect.forkScoped(
              Effect.forEach(
                Array.from({ length: 9 }),
                () =>
                  Effect.gen(function* () {
                    const message = yield* Queue.take(bindingQueue)
                    const output =
                      message.request.module === "context"
                        ? { threadId: "thread-concurrent-bindings" }
                        : {
                            text: `${(yield* Schema.decodeUnknownEffect(Schema.Struct({ path: Schema.String }))(message.request.input)).path}:content`,
                          }
                    yield* Effect.sleep("1 millis")
                    socket.message({
                      _tag: "BindingResult",
                      access,
                      operationKey: message.operationKey,
                      attempt: message.attempt,
                      callId: message.callId,
                      requestDigest: message.requestDigest,
                      outcome: { _tag: "Returned", response: { _tag: "Success", output } },
                    })
                  }),
                { discard: true },
              ),
            )
            const paths = Array.from({ length: 8 }, (_, index) => `docs/spec/${index}.md`)
            const encodedPaths = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)))(paths)
            socket.message({
              _tag: "CellExecute",
              request: {
                access,
                operationKey: "operation-concurrent-bindings",
                workspaceId: "workspace-concurrent-bindings",
                sessionId: "session-concurrent-bindings",
                threadId: "thread-concurrent-bindings",
                turnId: "turn-concurrent-bindings",
                runId: "run-concurrent-bindings",
                rootRunId: "run-concurrent-bindings",
                toolCallId: "call-concurrent-bindings",
                code: `const paths = ${encodedPaths}; Object.fromEntries(await Promise.all(paths.map(async (path) => [path, (await rika.workspace.read({ path })).text])))`,
                attempt: 0,
                replayPolicy: "never",
                admittedAt: null,
                deadlineAt: "2999-01-01T00:00:00.000Z",
                bindings: manifest,
              },
            })
            const completed = yield* eventuallyLive(() =>
              socket
                .frames("Terminal")
                .find((message) => message.frame.attribution.operationKey === "operation-concurrent-bindings"),
            )
            socket.message({
              _tag: "CellTerminalReceipt",
              access,
              operationKey: "operation-concurrent-bindings",
              attempt: completed.frame.attribution.attempt,
              cursor: completed.frame.cursor,
            })
            expect(completed.frame.response).toMatchObject({ _tag: "Success" })
            if (completed.frame.response._tag !== "Success") return
            const result = yield* Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.String }))(
              completed.frame.response.result,
            )
            expect(
              yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(
                result.value,
              ),
            ).toEqual(Object.fromEntries(paths.map((path) => [path, `${path}:content`])))
            expect(bindingCalls).toHaveLength(9)
            expect(new Set(bindingCalls.map((call) => call.callId))).toHaveLength(9)
            yield* Fiber.interrupt(runner)
          }).pipe(provideLayer(BunFileSystem.layer)),
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

  it.effect("reconnects with the same fence and resends an unacknowledged result", () =>
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
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const socket = yield* eventually(() => FakeWebSocket.instances[0])
            const hello = yield* eventually(() => socket.messages("RunnerHello")[0])
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
                leaseExpiresAt: 120_000,
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
              replayPolicy: "pure" as const,
              admittedAt: null,
              deadlineAt: "2999-01-01T00:00:00.000Z",
              bindings,
            }
            socket.message({ _tag: "CellExecute", request: reconnectRequest })
            const initialTerminal = yield* terminal(socket, "operation-reconnect")
            expect(initialTerminal.frame.response).toMatchObject({ _tag: "Success" })
            const initialResponse = yield* Schema.decodeUnknownEffect(CellSuccessValue)(initialTerminal.frame.response)
            socket.close()
            for (let index = 0; index < 10; index += 1) {
              yield* Effect.yieldNow
              yield* TestClock.adjust("250 millis")
            }
            const reconnectedSocket = yield* eventually(() => FakeWebSocket.instances[1])
            const reconnect = yield* eventually(() => reconnectedSocket.messages("ExecutorReconnect")[0])
            expect(reconnect.access.fence).toEqual(access.fence)
            const renewed: AccessWire = { ...access, leaseEpoch: 2 }
            reconnectedSocket.message({
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
            reconnectedSocket.message({
              _tag: "CellReplay",
              access: renewed,
              operationKey: "operation-reconnect",
              attempt: 0,
              afterCursor: 0,
            })
            yield* acknowledgeTerminal(reconnectedSocket, renewed, "operation-reconnect")
            const resent = yield* eventually(() =>
              reconnectedSocket
                .messages("LocalCellResult")
                .find((message) => message.operationKey === "operation-reconnect"),
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
            const afterReconnect = yield* eventually(() =>
              reconnectedSocket
                .messages("LocalCellResult")
                .find((message) => message.operationKey === "operation-after-reconnect"),
            )
            expect(afterReconnect.response).toMatchObject({
              _tag: "Success",
              result: { value: initialResponse.result.value },
            })
            yield* Fiber.interrupt(runner)
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
})
