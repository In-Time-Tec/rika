import * as BunServices from "@effect/platform-bun/BunServices"
import { ProductClientError } from "@rika/client/product"
import type { RunnerClient, RunnerEnrollmentRequest } from "@rika/client/runner"
import { WorkspaceBinding, workspaceExecutorWebSocketProtocol, type ExecutorFenceError } from "@rika/execution"
import { Effect, Fiber, FileSystem, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { runRunnerDaemon } from "../src/daemon"

const expected = {
  workspaceId: "runner-workspace",
  checkoutFingerprint: "runner-checkout",
  buildId: "runner-build",
  protocolVersion: 1,
} as const

const runnerBinding = (
  overrides: {
    readonly workspaceId?: string
    readonly checkoutFingerprint?: string
    readonly buildId?: string
    readonly protocolVersion?: number
  } = {},
) => {
  const workspaceId = overrides.workspaceId ?? expected.workspaceId
  return Schema.decodeSync(WorkspaceBinding)({
    workspaceId,
    assignmentId: "runner-assignment-1",
    generation: 1,
    placement: {
      _tag: "Runner",
      workspaceId,
      checkoutFingerprint: overrides.checkoutFingerprint ?? expected.checkoutFingerprint,
    },
    buildId: overrides.buildId ?? expected.buildId,
    protocolVersion: overrides.protocolVersion ?? expected.protocolVersion,
  })
}

const binding = runnerBinding()

const orbBinding = Schema.decodeSync(WorkspaceBinding)({
  ...binding,
  placement: { _tag: "Orb", workspaceId: expected.workspaceId, lineageId: "orb-lineage" },
})

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

const yieldUntil = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      if (condition()) return
      yield* Effect.yieldNow
    }
    return yield* Effect.die("condition did not become true")
  })

const settle = Effect.gen(function* () {
  for (let attempt = 0; attempt < 50; attempt += 1) yield* Effect.yieldNow
})

class FakeWebSocket extends EventTarget implements globalThis.WebSocket {
  readonly CONNECTING = globalThis.WebSocket.CONNECTING
  readonly OPEN = globalThis.WebSocket.OPEN
  readonly CLOSING = globalThis.WebSocket.CLOSING
  readonly CLOSED = globalThis.WebSocket.CLOSED
  binaryType: "arraybuffer" | "nodebuffer" = "arraybuffer"
  readonly bufferedAmount = 0
  readonly extensions = ""
  onclose: ((this: WebSocket, event: CloseEvent) => void) | null = null
  onerror: ((this: WebSocket, event: Event) => void) | null = null
  onmessage: ((this: WebSocket, event: MessageEvent) => void) | null = null
  onopen: ((this: WebSocket, event: Event) => void) | null = null
  readonly protocol = workspaceExecutorWebSocketProtocol
  readyState: globalThis.WebSocket["readyState"] = globalThis.WebSocket.CONNECTING
  readonly url = "wss://rika.test/api/v2/threads/thread/executor"
  readonly URL = this.url
  closeCalls = 0
  readonly sent: Array<string | ArrayBufferLike | ArrayBufferView> = []

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data)
  }

  ping(): void {}

  pong(): void {}

  terminate(): void {
    this.finish(1_006, "terminated")
  }

  close(code = 1_000, reason = ""): void {
    this.closeCalls += 1
    this.finish(code, reason)
  }

  open(): void {
    this.readyState = globalThis.WebSocket.OPEN
    this.dispatchEvent(new Event("open"))
  }

  serverClose(): void {
    this.finish(1_006, "transport unavailable")
  }

  private finish(code: number, reason: string): void {
    if (this.readyState === globalThis.WebSocket.CLOSED) return
    this.readyState = globalThis.WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent("close", { code, reason }))
  }
}

it.effect("rejects every unexpected binding fence before checkout or socket acquisition", () =>
  withPlatform(
    Effect.gen(function* () {
      const mismatches: ReadonlyArray<readonly [WorkspaceBinding, ExecutorFenceError["reason"]]> = [
        [runnerBinding({ workspaceId: "other-workspace" }), "workspace"],
        [runnerBinding({ checkoutFingerprint: "other-checkout" }), "placement"],
        [runnerBinding({ buildId: "other-build" }), "build"],
        [runnerBinding({ protocolVersion: 2 }), "protocol"],
        [orbBinding, "placement"],
      ]
      let enrollmentCalls = 0
      let socketCalls = 0
      for (const [candidate, reason] of mismatches) {
        const client = {
          binding: () => Effect.succeed(candidate),
          enrollmentRequest: () =>
            Effect.sync(() => {
              enrollmentCalls += 1
              return { url: "wss://unreachable.test", headers: {}, protocols: [] }
            }),
        } satisfies Pick<RunnerClient, "binding" | "enrollmentRequest">
        const result = yield* Effect.result(
          runRunnerDaemon({
            checkout: "/rika-runner-daemon-checkout-must-not-be-read",
            threadId: "thread",
            expected,
            client,
            connect: () => {
              socketCalls += 1
              return new FakeWebSocket()
            },
          }),
        )
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason } })
      }
      expect(enrollmentCalls).toBe(0)
      expect(socketCalls).toBe(0)
    }),
  ),
)

it.effect("refreshes enrollment on reconnect and caps interruptible transport backoff", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-daemon-" })
      const requests: Array<RunnerEnrollmentRequest> = []
      const sockets: Array<FakeWebSocket> = []
      let enrollment = 0
      const client = {
        binding: () => Effect.succeed(binding),
        enrollmentRequest: () =>
          Effect.sync(() => ({
            url: `wss://rika.test/executor?attempt=${enrollment}`,
            headers: { authorization: `fresh-${enrollment++}` },
            protocols: [workspaceExecutorWebSocketProtocol],
          })),
      } satisfies Pick<RunnerClient, "binding" | "enrollmentRequest">
      const daemon = yield* runRunnerDaemon({
        checkout,
        threadId: "thread",
        expected,
        client,
        connect: (request) => {
          requests.push(request)
          const socket = new FakeWebSocket()
          sockets.push(socket)
          return socket
        },
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* yieldUntil(() => sockets.length === 1)
      const delays = [250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]
      for (let index = 0; index < delays.length; index += 1) {
        sockets[index]!.open()
        sockets[index]!.serverClose()
        yield* settle
        yield* TestClock.adjust(delays[index]! - 1)
        yield* settle
        expect(sockets).toHaveLength(index + 1)
        yield* TestClock.adjust(1)
        yield* yieldUntil(() => sockets.length === index + 2)
      }
      expect(requests.map((request) => request.headers.authorization)).toEqual([
        "fresh-0",
        "fresh-1",
        "fresh-2",
        "fresh-3",
        "fresh-4",
        "fresh-5",
        "fresh-6",
        "fresh-7",
      ])
      sockets.at(-1)!.open()
      yield* Fiber.interrupt(daemon)
      expect(sockets.at(-1)).toMatchObject({ closeCalls: 1, readyState: globalThis.WebSocket.CLOSED })
    }),
  ),
)

it.effect("fails closed on unauthorized and forbidden enrollment instead of retrying", () =>
  withPlatform(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-daemon-auth-" })
      let enrollmentCalls = 0
      let socketCalls = 0
      for (const kind of ["unauthorized", "forbidden"] as const) {
        const client = {
          binding: () => Effect.succeed(binding),
          enrollmentRequest: () =>
            Effect.sync(() => {
              enrollmentCalls += 1
            }).pipe(
              Effect.andThen(Effect.fail(ProductClientError.make({ kind, message: "Runner enrollment was rejected" }))),
            ),
        } satisfies Pick<RunnerClient, "binding" | "enrollmentRequest">
        const result = yield* Effect.result(
          runRunnerDaemon({
            checkout,
            threadId: "thread",
            expected,
            client,
            connect: () => {
              socketCalls += 1
              return new FakeWebSocket()
            },
          }),
        )
        expect(result).toMatchObject({ _tag: "Failure", failure: { kind } })
      }
      yield* TestClock.adjust("1 hour")
      expect(enrollmentCalls).toBe(2)
      expect(socketCalls).toBe(0)
    }),
  ),
)
