import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
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
  it.live("keeps an in-flight binding pending and completes it after reconnect", () =>
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
                  assignmentId: "assignment-binding-reconnect",
                  admissionId: "admission-binding-reconnect",
                  ticket: "one-use-ticket",
                  executorUrl: "wss://controller.example.test/api/v1/runners",
                  workspaceIdentity: "workspace-binding-1",
                  expiresAt: 9_999_999_999_999,
                },
                workspacePath: "/tmp",
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const firstSocket = yield* eventually(() => FakeWebSocket.instances[0])
            const hello = yield* eventually(() => firstSocket.messages("RunnerHello")[0])
            const access: AccessWire = {
              version: 1,
              fence: {
                target: "runner",
                assignmentId: "assignment-binding-reconnect",
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
                leaseExpiresAt: 9_999_999_999_999,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            yield* Deferred.await(ready)
            const manifest = yield* bindingManifest([{ module: "context", operations: ["current"] }]).pipe(
              Effect.provide(foregroundContext),
            )
            const firstBindingSent =
              yield* Deferred.make<Extract<RunnerMessageValue, { readonly _tag: "BindingInvoke" }>>()
            const replayedBindingSent =
              yield* Deferred.make<Extract<RunnerMessageValue, { readonly _tag: "BindingInvoke" }>>()
            const terminalSent = yield* Deferred.make<
              CellLifecycleMessage & {
                readonly frame: Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }>
              }
            >()
            FakeWebSocket.onSend = (socket, message) => {
              if (message._tag === "BindingInvoke" && message.operationKey === "operation-binding-reconnect") {
                Deferred.doneUnsafe(
                  socket === firstSocket ? firstBindingSent : replayedBindingSent,
                  Effect.succeed(message),
                )
              }
              if (message._tag !== "CellLifecycle" || !hasFrameTag("Terminal")(message)) return
              if (message.frame.attribution.operationKey === "operation-binding-reconnect")
                Deferred.doneUnsafe(terminalSent, Effect.succeed(message))
            }
            firstSocket.message({
              _tag: "CellExecute",
              request: {
                access,
                operationKey: "operation-binding-reconnect",
                workspaceId: "workspace-binding-1",
                sessionId: "session-binding-reconnect",
                threadId: "thread-1",
                turnId: "turn-1",
                runId: "run-1",
                rootRunId: "run-1",
                toolCallId: "call-binding-reconnect",
                code: "await rika.context.current({})",
                attempt: 0,
                replayPolicy: "never",
                admittedAt: null,
                deadlineAt: "2999-01-01T00:00:00.000Z",
                bindings: manifest,
              },
            })
            const firstBinding = yield* Deferred.await(firstBindingSent)
            expect(firstBinding.access).toEqual(access)
            firstSocket.close()
            const secondSocket = yield* eventuallyLive(() => FakeWebSocket.instances[1])
            yield* eventuallyLive(() => secondSocket.messages("ExecutorReconnect")[0])
            const renewed: AccessWire = { ...access, leaseEpoch: 2 }
            secondSocket.message({
              _tag: "ExecutorReconnected",
              welcome: {
                version: 1,
                fence: renewed.fence,
                leaseEpoch: renewed.leaseEpoch,
                leaseExpiresAt: 9_999_999_999_999,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            const replayed = yield* Deferred.await(replayedBindingSent)
            expect(replayed).toMatchObject({
              access: renewed,
              callId: firstBinding.callId,
              requestDigest: firstBinding.requestDigest,
            })
            yield* Effect.sleep("10 millis")
            secondSocket.message({
              _tag: "BindingResult",
              access: renewed,
              operationKey: replayed.operationKey,
              attempt: replayed.attempt,
              callId: replayed.callId,
              requestDigest: replayed.requestDigest,
              outcome: {
                _tag: "Returned",
                response: { _tag: "Success", output: { threadId: "thread-1" } },
              },
            })
            const followup = yield* eventuallyLive(() =>
              secondSocket.messages("BindingInvoke").find((message) => message.callId !== replayed.callId),
            )
            secondSocket.message({
              _tag: "BindingResult",
              access: renewed,
              operationKey: followup.operationKey,
              attempt: followup.attempt,
              callId: followup.callId,
              requestDigest: followup.requestDigest,
              outcome: {
                _tag: "Returned",
                response: { _tag: "Success", output: { threadId: "thread-1" } },
              },
            })
            const completed = yield* Deferred.await(terminalSent)
            secondSocket.message({
              _tag: "CellTerminalReceipt",
              access: renewed,
              operationKey: "operation-binding-reconnect",
              attempt: completed.frame.attribution.attempt,
              cursor: completed.frame.cursor,
            })
            expect(completed.frame.response).toMatchObject({
              _tag: "Success",
              result: { value: '{"threadId":"thread-1"}' },
            })
            expect(
              [...firstSocket.sent, ...secondSocket.sent].filter(
                (message) =>
                  message._tag === "CellLifecycle" &&
                  message.frame._tag === "Started" &&
                  message.frame.attribution.operationKey === "operation-binding-reconnect",
              ),
            ).toHaveLength(1)
            expect(
              [...firstSocket.sent, ...secondSocket.sent].filter(
                (message) => message._tag === "BindingInvoke" && message.callId === firstBinding.callId,
              ),
            ).toHaveLength(2)
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
})
