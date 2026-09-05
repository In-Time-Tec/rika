import { describe, expect, it } from "@effect/vitest"
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem"
import { Deferred, Effect, Fiber, FileSystem, Layer, Schema } from "effect"
import { foregroundRunnerLayer, runForegroundRunner } from "../../../src/host/session/foreground"
import {
  ApiMessage,
  RunnerMessage,
  type AccessWire,
  type ApiMessage as ApiMessageValue,
  type RunnerMessage as RunnerMessageValue,
} from "../../../src/protocol/messages"
import { provideLayer } from "../../support/layer"

const hasTag =
  <Tag extends RunnerMessageValue["_tag"]>(tag: Tag) =>
  (message: RunnerMessageValue): message is Extract<RunnerMessageValue, { readonly _tag: Tag }> =>
    message._tag === tag

class FakeWebSocket {
  static current: FakeWebSocket | undefined
  readonly readyState = 1
  readonly sent: Array<RunnerMessageValue> = []
  closed = false
  private readonly listeners = new Map<string, Set<EventListener>>()

  constructor(_url: string) {
    FakeWebSocket.current = this
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
    this.sent.push(Schema.decodeSync(Schema.fromJsonString(RunnerMessage))(value))
  }

  close() {
    this.closed = true
    this.emit("close", new CloseEvent("close", { code: 1000, reason: "test complete" }))
  }

  emit(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  message(value: ApiMessageValue) {
    const data = Schema.encodeSync(Schema.fromJsonString(ApiMessage))(value)
    this.emit("message", new MessageEvent<string>("message", { data }))
  }

  messages<Tag extends RunnerMessageValue["_tag"]>(tag: Tag) {
    return this.sent.filter(hasTag(tag))
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
      duration: "2 seconds",
      orElse: () => Effect.fail(EventuallyTimeout.make({ message: "timed out" })),
    }),
  )

const machineResult = (socket: FakeWebSocket, machineId: string, occurrence = 0) =>
  eventually(() => socket.messages("MachineResult").filter((message) => message.machineId === machineId)[occurrence])

describe("foreground Runner", { concurrent: false }, () => {
  it.live("executes, cancels, receipts, and persists native machine calls", () =>
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
            const workspaceIdentity = `test:${workspacePath}`
            const ready = yield* Deferred.make<
              void,
              import("../../../src/host/session/foreground").ForegroundRunnerError
            >()
            let latestSnapshot: import("../../../src/host/session/foreground").ForegroundRunnerSnapshot | undefined
            const runner = yield* Effect.forkScoped(
              runForegroundRunner({
                admission: {
                  assignmentId: "assignment-1",
                  admissionId: "admission-1",
                  ticket: "one-use-ticket",
                  executorUrl: "wss://controller.example.test/api/v1/runners",
                  workspaceIdentity,
                  expiresAt: 9_999_999_999_999,
                },
                workspacePath,
                receiptScope: "native-tools",
                receiptStore: {
                  save: (_scope, snapshot) =>
                    Effect.sync(() => {
                      latestSnapshot = snapshot
                    }),
                },
                ready,
              }).pipe(Effect.provide(foregroundContext)),
            )
            const socket = yield* eventually(() => FakeWebSocket.current)
            const hello = yield* eventually(() => socket.messages("RunnerHello")[0])
            expect(hello.hello.capabilities).toEqual({ nativeTools: true, checkpoints: false, pty: false })
            expect(hello.hello.workspaceCapabilities.nativeTools).toEqual({
              _tag: "Ready",
              detail: "native tools available",
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
                leaseExpiresAt: 9_999_999_999_999,
                heartbeatIntervalMillis: 60_000,
                cursor: { sequence: 0, value: "" },
              },
            })
            yield* Deferred.await(ready)
            const requestDigest = "a".repeat(64)
            socket.message({
              _tag: "MachineExecute",
              access,
              operationKey: "operation-cancel",
              attempt: 0,
              machineId: "machine-cancel",
              requestDigest,
              request: { _tag: "NativeTool", request: { _tag: "Bash", command: "sleep 30" } },
            })
            socket.message({
              _tag: "MachineCancel",
              access,
              operationKey: "operation-cancel",
              attempt: 0,
              machineId: "machine-cancel",
              requestDigest,
            })
            expect((yield* machineResult(socket, "machine-cancel")).outcome).toEqual({ _tag: "Cancelled" })
            socket.message({
              _tag: "MachineCancel",
              access,
              operationKey: "operation-cancel",
              attempt: 0,
              machineId: "machine-cancel",
              requestDigest,
            })
            expect((yield* machineResult(socket, "machine-cancel", 1)).outcome).toEqual({ _tag: "Cancelled" })

            socket.message({
              _tag: "MachineExecute",
              access,
              operationKey: "operation-write",
              attempt: 0,
              machineId: "machine-write",
              requestDigest: "b".repeat(64),
              request: {
                _tag: "NativeTool",
                request: { _tag: "Bash", command: "printf native > native.txt" },
              },
            })
            expect((yield* machineResult(socket, "machine-write")).outcome._tag).toBe("Success")
            expect(yield* fileSystem.readFileString(`${workspacePath}/native.txt`)).toBe("native")

            socket.message({
              _tag: "LeaseReceipt",
              receipt: {
                version: 1,
                fence: access.fence,
                leaseEpoch: 1,
                leaseExpiresAt: 9_999_999_999_999,
                cursor: { sequence: 1, value: "receipt-1" },
              },
            })
            yield* eventually(() => (latestSnapshot?.cursor.sequence === 1 ? latestSnapshot : undefined))
            expect(latestSnapshot?.machines).toContainEqual({
              machineId: "machine-cancel",
              state: { _tag: "Completed", requestDigest, outcome: { _tag: "Cancelled" } },
            })
            yield* Fiber.interrupt(runner)
            expect(yield* eventually(() => (socket.closed ? true : undefined))).toBe(true)
          }),
        ).pipe(provideLayer(BunFileSystem.layer)),
      (original) =>
        Effect.sync(() => {
          Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: original, writable: true })
          FakeWebSocket.current = undefined
        }),
    ),
  )
})
