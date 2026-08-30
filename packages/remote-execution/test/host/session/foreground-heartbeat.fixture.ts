import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { foregroundRunnerLayer, runForegroundRunner } from "../../../src/host/session/foreground"
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

const _acknowledgeTerminal = (socket: FakeWebSocket, access: AccessWire, operationKey: string, occurrence = 0) =>
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

const _bindings = {
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
  it.effect("retries reconnects while the controller is unavailable before the WebSocket opens", () =>
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
                  assignmentId: "assignment-open-retry",
                  admissionId: "admission-open-retry",
                  ticket: "one-use-ticket",
                  executorUrl: "wss://controller.example.test/api/v1/runners",
                  workspaceIdentity: "workspace-binding-1",
                  expiresAt: 9_999_999_999_999,
                },
                workspacePath: "/tmp",
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const initial = yield* eventually(() => FakeWebSocket.instances[0])
            const hello = yield* eventually(() => initial.messages("RunnerHello")[0])
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "runner",
                assignmentId: "assignment-open-retry",
                assignmentGeneration: 1,
                instanceId: "device-1",
                executorId: "executor-1",
                processIncarnation: hello.hello.processIncarnation,
              },
              leaseEpoch: 1,
              sessionToken: "session-1",
            }
            initial.message({
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
            FakeWebSocket.failedOpens = 2
            initial.close()
            yield* TestClock.adjust("250 millis")
            const first = yield* eventually(() => {
              const socket = FakeWebSocket.instances[1]
              return socket?.listensFor("error") === true ? socket : undefined
            })
            first.failOpening()
            yield* TestClock.adjust("250 millis")
            const second = yield* eventually(() => {
              const socket = FakeWebSocket.instances[2]
              return socket?.listensFor("error") === true ? socket : undefined
            })
            second.failOpening()
            yield* TestClock.adjust("250 millis")
            const connected = yield* eventually(() => FakeWebSocket.instances[3])
            expect(FakeWebSocket.instances).toHaveLength(4)
            const reconnect = yield* eventually(() => connected.messages("ExecutorReconnect")[0])
            expect(reconnect).toEqual({ _tag: "ExecutorReconnect", access })
            connected.message({
              _tag: "ExecutorReconnected",
              welcome: {
                version: 1,
                fence: access.fence,
                leaseEpoch: 2,
                leaseExpiresAt: 120_000,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            yield* Effect.yieldNow
            yield* Fiber.interrupt(runner)
          }),
        ),
      (original) =>
        Effect.sync(() => {
          Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original, writable: true })
          FakeWebSocket.current = undefined
          FakeWebSocket.instances.length = 0
          FakeWebSocket.failedOpens = 0
        }),
    ),
  )

  it.effect("reconnects before the lease expires when heartbeat receipts stop", () =>
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
                  assignmentId: "assignment-watchdog",
                  admissionId: "admission-watchdog",
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
                assignmentId: "assignment-watchdog",
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
                leaseExpiresAt: 60_000,
                heartbeatIntervalMillis: 20_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            yield* Deferred.await(ready)
            yield* Effect.yieldNow
            yield* TestClock.adjust("40 seconds")
            for (let index = 0; index < 10 && FakeWebSocket.instances.length < 2; index += 1) {
              yield* Effect.yieldNow
              yield* TestClock.adjust("250 millis")
            }
            expect(FakeWebSocket.instances).toHaveLength(2)
            expect(FakeWebSocket.instances[1]?.messages("ExecutorReconnect")[0]).toMatchObject({
              _tag: "ExecutorReconnect",
              access,
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
