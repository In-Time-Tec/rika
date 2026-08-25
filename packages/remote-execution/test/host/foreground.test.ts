import { describe, expect, it } from "@effect/vitest"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Clock, DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { foregroundRunnerLayer, runForegroundRunner } from "../../src/host/foreground"
import {
  ApiMessage,
  RunnerMessage,
  bindingManifest,
  type AccessWire,
  type ApiMessage as ApiMessageValue,
  type CellLifecycleFrame,
  type RunnerMessage as RunnerMessageValue,
} from "../../src/protocol/messages"
import { provideLayer } from "../support/layer"

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
    return value === undefined ? Effect.sleep("10 millis").pipe(Effect.andThen(eventuallyLive(read))) : Effect.succeed(value)
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

const CellFailureWire = Schema.Struct({
  kind: Schema.Literals(["cancelled", "timeout", "workspace"]),
  message: Schema.String,
})

const CellSuccessValue = Schema.TaggedStruct("Success", {
  result: Schema.Struct({ value: Schema.Json }),
})

describe.sequential("foreground Runner", () => {
  it.effect("uses only a local admission and replays cell results in memory", () =>
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
            const workspacePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-" })
            const ready = yield* Deferred.make<void, import("../../src/host/foreground").ForegroundRunnerError>()
            const terminalPersistenceStarted = yield* Deferred.make<void>()
            const releaseTerminalPersistence = yield* Deferred.make<void>()
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
                workspacePath,
                receiptScope: "cancellation-race",
                receiptStore: {
                  save: (_scope, snapshot) => {
                    const deadline = snapshot.receipts.find((receipt) => receipt.operationKey === "operation-deadline")
                    return deadline?.frames.some((frame) => frame._tag === "Terminal") === true
                      ? Deferred.succeed(terminalPersistenceStarted, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseTerminalPersistence)),
                        )
                      : Effect.void
                  },
                },
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const socket = yield* eventually(() => FakeWebSocket.current)
            const hello = yield* eventually(() => socket.messages("RunnerHello")[0])
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
                sessionToken: "session-1",
                leaseExpiresAt: 120_000,
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
                deadlineAt: "2999-01-01T00:00:00.000Z",
                bindings,
              },
            })
            yield* acknowledgeTerminal(socket, access, "operation-mismatch")
            const mismatch = yield* eventually(() =>
              socket.messages("LocalCellResult").find((message) => message.operationKey === "operation-mismatch"),
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
              deadlineAt: "2999-01-01T00:00:00.000Z",
              bindings,
            }
            socket.message({ _tag: "CellExecute", request })
            yield* acknowledgeTerminal(socket, access, "operation-1")
            const first = yield* eventually(() =>
              socket.messages("LocalCellResult").find((message) => message.operationKey === "operation-1"),
            )
            expect(first.response._tag).toBe("Success")
            socket.message({ _tag: "CellExecute", request })
            yield* acknowledgeTerminal(socket, access, "operation-1", 1)
            const results = yield* eventually(() => {
              const values = socket
                .messages("LocalCellResult")
                .filter((message) => message.operationKey === "operation-1")
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
            const lifecycleReplays = socket
              .messages("CellLifecycle")
              .filter((message) => message.frame.attribution.operationKey === "operation-1")
              .map((message) => message.frame)
            const terminalIndex = lifecycleReplays.findIndex((frame) => frame._tag === "Terminal")
            const firstLifecycle = lifecycleReplays.slice(0, terminalIndex + 1)
            expect(firstLifecycle.map((frame) => frame.cursor)).toEqual(
              firstLifecycle.map((_frame, index) => index + 1),
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
            const output = yield* eventually(() =>
              socket.frames("Output").find((message) => message.frame.attribution.operationKey === "operation-output"),
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
            FakeWebSocket.onSend = (origin, message) => {
              if (
                message._tag !== "CellLifecycle" ||
                message.frame._tag !== "Accepted" ||
                message.frame.attribution.operationKey !== "operation-cancel"
              )
                return
              FakeWebSocket.onSend = undefined
              origin.message({
                _tag: "CellCancel",
                access,
                operationKey: "operation-cancel",
                attempt: 0,
              })
            }
            socket.message({ _tag: "CellExecute", request: cancelRequest })
            const cancelled = yield* acknowledgeTerminal(socket, access, "operation-cancel")
            expect(cancelled.frame.response).toEqual({
              _tag: "DomainFailure",
              failure: { kind: "cancelled", message: "Cell operation cancelled" },
            })
            expect(cancelled.frame.outcome).toBe("cancelled")
            expect(
              socket
                .messages("CellLifecycle")
                .filter((message) => message.frame.attribution.operationKey === "operation-cancel")
                .map((message) => message.frame._tag),
            ).toEqual(["Accepted", "Started", "Terminal"])
            const deadlineRequest = {
              ...request,
              operationKey: "operation-deadline",
              toolCallId: "call-deadline",
              sessionId: "session-deadline",
              code: "await new Promise<void>(() => {})",
              deadlineAt: DateTime.formatIso(DateTime.makeUnsafe((yield* Clock.currentTimeMillis) + 100)),
            }
            socket.message({ _tag: "CellExecute", request: deadlineRequest })
            yield* eventually(() =>
              socket
                .frames("Started")
                .find((message) => message.frame.attribution.operationKey === "operation-deadline"),
            )
            yield* TestClock.adjust("100 millis")
            yield* Deferred.await(terminalPersistenceStarted)
            socket.message({
              _tag: "CellCancel",
              access,
              operationKey: "operation-deadline",
              attempt: 0,
            })
            yield* Effect.yieldNow
            expect(
              socket
                .frames("Terminal")
                .filter((message) => message.frame.attribution.operationKey === "operation-deadline"),
            ).toEqual([])
            yield* Deferred.succeed(releaseTerminalPersistence, undefined)
            const timedOut = yield* acknowledgeTerminal(socket, access, "operation-deadline")
            expect(timedOut.frame.response).toEqual({
              _tag: "DomainFailure",
              failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
            })
            expect(timedOut.frame.outcome).toBe("failed")
            expect(
              socket
                .frames("Terminal")
                .filter((message) => message.frame.attribution.operationKey === "operation-deadline"),
            ).toHaveLength(1)
            socket.message({ _tag: "CellExecute", request: deadlineRequest })
            const replayedTimeout = yield* acknowledgeTerminal(socket, access, "operation-deadline", 1)
            expect(replayedTimeout.frame.response).toEqual(timedOut.frame.response)
            expect(
              socket
                .frames("Terminal")
                .filter(
                  (message) =>
                    message.frame.attribution.operationKey === "operation-deadline" &&
                    message.frame.response._tag === "DomainFailure" &&
                    Schema.is(CellFailureWire)(message.frame.response.failure) &&
                    message.frame.response.failure.kind === "cancelled",
                ),
            ).toEqual([])
            expect(yield* fileSystem.readDirectory(workspacePath)).toEqual([])
            yield* Fiber.interrupt(runner)
            expect(yield* eventually(() => (socket.closed ? true : undefined))).toBe(true)
          }),
        ).pipe(provideLayer(BunFileSystem.layer)),
      (original) =>
        Effect.sync(() => {
          Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original, writable: true })
          FakeWebSocket.current = undefined
          FakeWebSocket.instances.length = 0
          FakeWebSocket.onSend = undefined
          FakeWebSocket.failedOpens = 0
        }),
    ),
  )

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
            const ready = yield* Deferred.make<void, import("../../src/host/foreground").ForegroundRunnerError>()
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
            const ready = yield* Deferred.make<void, import("../../src/host/foreground").ForegroundRunnerError>()
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
            expect(
              FakeWebSocket.instances[1]?.messages("ExecutorReconnect")[0],
            ).toMatchObject({ _tag: "ExecutorReconnect", access })
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
            const ready = yield* Deferred.make<void, import("../../src/host/foreground").ForegroundRunnerError>()
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
            const firstBindingSent = yield* Deferred.make<Extract<RunnerMessageValue, { readonly _tag: "BindingInvoke" }>>()
            const replayedBindingSent = yield* Deferred.make<Extract<RunnerMessageValue, { readonly _tag: "BindingInvoke" }>>()
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
              result: { value: "{ threadId: 'thread-1' }" },
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
                (message) =>
                  message._tag === "BindingInvoke" && message.callId === firstBinding.callId,
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
            const ready = yield* Deferred.make<void, import("../../src/host/foreground").ForegroundRunnerError>()
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
            let latestSnapshot: import("../../src/host/foreground").ForegroundRunnerSnapshot | undefined
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
            const ready = yield* Deferred.make<void, import("../../src/host/foreground").ForegroundRunnerError>()
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
            let latestSnapshot: import("../../src/host/foreground").ForegroundRunnerSnapshot | undefined
            const ready = yield* Deferred.make<void, import("../../src/host/foreground").ForegroundRunnerError>()
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
