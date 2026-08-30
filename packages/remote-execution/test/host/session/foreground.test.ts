import "./foreground-bindings.fixture"
import "./foreground-heartbeat.fixture"
import "./foreground-reconnect.fixture"
import "./foreground-recovery.fixture"
import { describe, expect, it } from "@effect/vitest"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Clock, DateTime, Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect"
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

const CellFailureWire = Schema.Struct({
  kind: Schema.Literals(["cancelled", "timeout", "workspace"]),
  message: Schema.String,
})

const _CellSuccessValue = Schema.TaggedStruct("Success", {
  result: Schema.Struct({ value: Schema.Json }),
})

describe("foreground Runner", { concurrent: false }, () => {
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
            const ready = yield* Deferred.make<
              void,
              import("../../../src/host/session/foreground").ForegroundRunnerError
            >()
            const terminalPersistenceStarted = yield* Deferred.make<void>()
            const releaseTerminalPersistence = yield* Deferred.make<void>()
            let latestSnapshot: import("../../../src/host/session/foreground").ForegroundRunnerSnapshot | undefined
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
                    const save =
                      deadline?.frames.some((frame) => frame._tag === "Terminal") === true
                        ? Deferred.succeed(terminalPersistenceStarted, undefined).pipe(
                            Effect.andThen(Deferred.await(releaseTerminalPersistence)),
                          )
                        : Effect.void
                    return save.pipe(
                      Effect.andThen(
                        Effect.sync(() => {
                          latestSnapshot = snapshot
                        }),
                      ),
                    )
                  },
                },
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const socket = yield* eventually(() => FakeWebSocket.current)
            const hello = yield* eventually(() => socket.messages("RunnerHello")[0])
            expect(hello._tag).toBe("RunnerHello")
            expect(hello.hello.admissionId).toBe("admission-1")
            expect(hello.hello.ticket).toBe("one-use-ticket")
            expect(hello.hello.processIncarnation.length).toBeGreaterThan(0)
            expect(hello.hello.capabilities).toEqual({ cells: true, checkpoints: false, pty: false })
            expect(hello.hello.workspaceCapabilities.environmentDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
            expect(hello.hello.workspaceCapabilities.typescriptKernel).toEqual({
              _tag: "Ready",
              detail: "persistent Bun TypeScript kernel available",
            })
            expect(hello.hello.cursors).toEqual({ command: 0, event: 0, pty: 0 })
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
            socket.message({
              _tag: "MachineExecute",
              access,
              operationKey: "operation-cancel",
              attempt: 0,
              machineId: "call-cancel:late",
              requestDigest: "a".repeat(64),
              request: {
                _tag: "CodingTool",
                request: { _tag: "Write", path: "forbidden-after-cancel.txt", content: "must-not-land" },
              },
            })
            const fencedMachine = yield* eventually(() =>
              socket.messages("MachineResult").find((message) => message.machineId === "call-cancel:late"),
            )
            expect(fencedMachine.outcome).toEqual({
              _tag: "Fenced",
              message: "Parent Cell is no longer running",
            })
            expect(yield* fileSystem.exists(`${workspacePath}/forbidden-after-cancel.txt`)).toBe(false)
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
            expect(
              latestSnapshot?.receipts.find((receipt) => receipt.operationKey === "operation-deadline")?.frames.at(-1)
                ?._tag,
            ).toBe("Terminal")
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
})
