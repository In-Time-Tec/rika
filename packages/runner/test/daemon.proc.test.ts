import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import type { RunnerClient, RunnerEnrollmentRequest } from "@rika/client/runner"
import {
  HandshakeRequest,
  WorkspaceBinding,
  makeWorkspaceExecutorWebSocketServer,
  workspaceExecutorWebSocketProtocol,
  type ExecutorEvidence,
  type WorkspaceExecutorService,
  type WorkspaceExecutorWebSocketServer,
} from "@rika/execution"
import { Effect, Fiber, FiberSet, FileSystem, Layer, Ref, Schema, Scope } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { runRunnerDaemon } from "../src/daemon"
import { makeNativeOperationIntent } from "../src/workspace"

const expected = {
  workspaceId: "daemon-workspace",
  checkoutFingerprint: "daemon-checkout",
  buildId: "daemon-build",
  protocolVersion: 1,
} as const

const binding = (assignmentId: string, generation: number) =>
  Schema.decodeSync(WorkspaceBinding)({
    workspaceId: expected.workspaceId,
    assignmentId,
    generation,
    placement: {
      _tag: "Runner",
      workspaceId: expected.workspaceId,
      checkoutFingerprint: expected.checkoutFingerprint,
    },
    buildId: expected.buildId,
    protocolVersion: expected.protocolVersion,
  })

const firstBinding = binding("daemon-assignment-1", 1)
const secondBinding = binding("daemon-assignment-2", 2)

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Layer.build(Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor)).pipe(
      Effect.flatMap((context) => Effect.provide(effect, context)),
    ),
  )

interface MountedConnection {
  readonly binding: WorkspaceBinding
  readonly id: string
  readonly server: WorkspaceExecutorWebSocketServer
  readonly token: string
  socket?: Bun.ServerWebSocket<{ readonly mountId: string }>
}

const loopbackHarness = Effect.gen(function* () {
  const ownerScope = yield* Effect.scope
  const mounts: Array<MountedConnection> = []
  const fibers = yield* FiberSet.make<void, never>()
  const run = yield* FiberSet.runtime(fibers)<never>()
  const acceptedTokens: Array<string> = []
  const closed = new Set<string>()
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve<{ readonly mountId: string }>({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request, bunServer) => {
          const url = new URL(request.url)
          const mountId = url.searchParams.get("mount")
          const mounted = mounts.find((candidate) => candidate.id === mountId)
          if (
            mounted === undefined ||
            url.searchParams.get("token") !== mounted.token ||
            request.headers.get("sec-websocket-protocol") !== workspaceExecutorWebSocketProtocol
          )
            return new Response("WebSocket enrollment required", { status: 401 })
          acceptedTokens.push(mounted.token)
          return bunServer.upgrade(request, {
            data: { mountId: mounted.id },
            headers: { "sec-websocket-protocol": workspaceExecutorWebSocketProtocol },
          })
            ? undefined
            : new Response("WebSocket upgrade required", { status: 426 })
        },
        websocket: {
          open: (socket) => {
            const mounted = mounts.find((candidate) => candidate.id === socket.data.mountId)
            if (mounted !== undefined) mounted.socket = socket
          },
          message: (socket, message) => {
            const mounted = mounts.find((candidate) => candidate.id === socket.data.mountId)
            if (mounted !== undefined) run(mounted.server.receive(message).pipe(Effect.ignore))
          },
          close: (socket) => {
            const mounted = mounts.find((candidate) => candidate.id === socket.data.mountId)
            closed.add(socket.data.mountId)
            if (mounted !== undefined) run(mounted.server.disconnected())
          },
        },
      }),
    ),
    (running) => Effect.tryPromise(() => running.stop(true)),
  )
  let serial = 0
  const mount = (workspaceBinding: WorkspaceBinding) =>
    Effect.gen(function* () {
      const id = `mount-${serial}`
      const token = `token-${serial++}`
      const adapter = yield* makeWorkspaceExecutorWebSocketServer({
        authorize: () => Effect.succeed(workspaceBinding),
        peer: {
          send: (frame) => mounts.find((candidate) => candidate.id === id)?.socket?.send(frame),
          close: (code, reason) => mounts.find((candidate) => candidate.id === id)?.socket?.close(code, reason),
        },
      })
      const mounted: MountedConnection = { binding: workspaceBinding, id, server: adapter, token }
      mounts.push(mounted)
      return {
        url: `ws://127.0.0.1:${server.port}/?mount=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`,
        headers: { authorization: `Bearer ${token}` },
        protocols: [workspaceExecutorWebSocketProtocol],
      } satisfies RunnerEnrollmentRequest
    }).pipe(Scope.provide(ownerScope), Effect.orDie)
  const awaitMount = (index: number) =>
    Effect.gen(function* () {
      while (mounts[index] === undefined) yield* Effect.sleep("10 millis")
      const mounted = mounts[index]
      yield* mounted.server.ready.pipe(Effect.timeout("5 seconds"))
      return mounted
    })
  const disconnect = (index: number) => Effect.sync(() => mounts[index]?.socket?.close(1_001, "fixture disconnect"))
  const awaitClosed = (index: number) =>
    Effect.gen(function* () {
      while (!closed.has(`mount-${index}`)) yield* Effect.sleep("10 millis")
    }).pipe(Effect.timeout("5 seconds"))
  return { acceptedTokens, awaitClosed, awaitMount, disconnect, mount, mounts }
})

const dispatch = (
  workspace: WorkspaceExecutorService,
  workspaceBinding: WorkspaceBinding,
  operationId: string,
  input: Schema.Json,
) =>
  Effect.gen(function* () {
    const intent = makeNativeOperationIntent({ binding: workspaceBinding, operationId, tool: "bash", input })
    const handshake = yield* workspace.handshake(HandshakeRequest.make({ binding: workspaceBinding }))
    return yield* workspace.dispatch(intent, input, handshake)
  })

const awaitFile = (fileSystem: FileSystem.FileSystem, path: string, expectedText: string) =>
  Effect.gen(function* () {
    while (true) {
      if ((yield* fileSystem.exists(path)) && (yield* fileSystem.readFileString(path)) === expectedText) return
      yield* Effect.sleep("10 millis")
    }
  }).pipe(Effect.timeout("5 seconds"))

const awaitReceipt = (workspace: WorkspaceExecutorService, operationId: string) =>
  Effect.gen(function* () {
    while (true) {
      const receipt = yield* workspace.receipt(operationId)
      if (receipt !== undefined) return receipt
      yield* Effect.sleep("10 millis")
    }
  }).pipe(Effect.timeout("5 seconds"))

const completed = (evidence: ExecutorEvidence): Schema.Json => {
  expect(evidence.outcome._tag).toBe("Completed")
  return evidence.outcome._tag === "Completed" ? evidence.outcome.result : null
}

it.live(
  "retains native work across reconnect, fences replacement, and closes the active generation on shutdown",
  () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-daemon-proc-" })
          const currentBinding = yield* Ref.make(firstBinding)
          const loopback = yield* loopbackHarness
          const constructor = yield* Socket.WebSocketConstructor
          const client = {
            binding: () => Ref.get(currentBinding),
            enrollmentRequest: () => Ref.get(currentBinding).pipe(Effect.flatMap(loopback.mount)),
          } satisfies Pick<RunnerClient, "binding" | "enrollmentRequest">
          const daemon = yield* runRunnerDaemon({
            checkout,
            threadId: "thread",
            expected,
            client,
            connect: (request) => constructor(request.url, [...request.protocols]),
          }).pipe(Effect.forkChild({ startImmediately: true }))

          const first = yield* loopback.awaitMount(0)
          const retainedInput = {
            command:
              "printf once >> retained.txt; while [ ! -f release-retained ]; do sleep 0.01; done; printf finished",
            timeout_ms: 0,
          }
          const retained = yield* dispatch(
            first.server.executor,
            firstBinding,
            "retained-operation",
            retainedInput,
          ).pipe(Effect.forkChild)
          yield* awaitFile(fileSystem, `${checkout}/retained.txt`, "once")
          yield* loopback.disconnect(0)
          expect(yield* Effect.result(Fiber.join(retained).pipe(Effect.timeout("5 seconds")))).toMatchObject({
            _tag: "Failure",
            failure: { phase: "after-dispatch" },
          })

          const reconnected = yield* loopback.awaitMount(1)
          yield* fileSystem.writeFileString(`${checkout}/release-retained`, "release")
          const receipt = yield* awaitReceipt(reconnected.server.executor, "retained-operation")
          expect(completed(receipt)).toMatchObject({ text: "finished", exitCode: 0 })
          expect(
            yield* dispatch(reconnected.server.executor, firstBinding, "retained-operation", retainedInput),
          ).toEqual(receipt)
          expect(yield* fileSystem.readFileString(`${checkout}/retained.txt`)).toBe("once")

          const replacedInput = {
            command:
              "printf started > replaced.txt; while [ ! -f release-replaced ]; do sleep 0.01; done; printf finished >> replaced.txt",
            timeout_ms: 0,
          }
          const replaced = yield* dispatch(
            reconnected.server.executor,
            firstBinding,
            "replaced-operation",
            replacedInput,
          ).pipe(Effect.forkChild)
          yield* awaitFile(fileSystem, `${checkout}/replaced.txt`, "started")
          yield* Ref.set(currentBinding, secondBinding)
          yield* loopback.disconnect(1)
          expect(yield* Effect.result(Fiber.join(replaced).pipe(Effect.timeout("5 seconds")))).toMatchObject({
            _tag: "Failure",
            failure: { phase: "after-dispatch" },
          })
          const replacement = yield* loopback.awaitMount(2)
          expect(yield* replacement.server.executor.receipt("replaced-operation")).toBeUndefined()
          expect(
            yield* Effect.result(
              replacement.server.executor.handshake(HandshakeRequest.make({ binding: firstBinding })),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { reason: "assignment" } })
          yield* fileSystem.writeFileString(`${checkout}/release-replaced`, "release")
          yield* Effect.sleep("250 millis")
          expect(yield* fileSystem.readFileString(`${checkout}/replaced.txt`)).toBe("started")

          const shutdownInput = {
            command:
              "printf started > shutdown.txt; while [ ! -f release-shutdown ]; do sleep 0.01; done; printf finished >> shutdown.txt",
            timeout_ms: 0,
          }
          const shuttingDown = yield* dispatch(
            replacement.server.executor,
            secondBinding,
            "shutdown-operation",
            shutdownInput,
          ).pipe(Effect.forkChild)
          yield* awaitFile(fileSystem, `${checkout}/shutdown.txt`, "started")
          yield* Fiber.interrupt(daemon)
          yield* loopback.awaitClosed(2)
          yield* fileSystem.writeFileString(`${checkout}/release-shutdown`, "release")
          yield* Effect.sleep("250 millis")
          expect(yield* fileSystem.readFileString(`${checkout}/shutdown.txt`)).toBe("started")
          expect((yield* Fiber.await(shuttingDown))._tag).toBe("Failure")
          expect(loopback.acceptedTokens).toEqual(["token-0", "token-1", "token-2"])
        }),
      ),
    ),
  30_000,
)
