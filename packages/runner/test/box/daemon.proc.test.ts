import * as BunServices from "@effect/platform-bun/BunServices"
import { BoxBootstrapDocument } from "@rika/box-executor/bootstrap"
import {
  HandshakeRequest,
  WorkspaceBinding,
  makeWorkspaceExecutorWebSocketServer,
  workspaceExecutorWebSocketProtocol,
  type ExecutorEvidence,
  type WorkspaceExecutorService,
  type WorkspaceExecutorWebSocketServer,
} from "@rika/execution"
import { Clock, Effect, Fiber, FiberSet, FileSystem, Layer, Schema, Scope } from "effect"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { testWebSocketConstructor } from "../../../../apps/api/test/fixtures/runner-socket"
import { runBoxExecutor } from "../../src/box/daemon"
import { makeNativeOperationIntent } from "../../src/workspace"

const boxId = "bx_23456789"
const expected = { buildId: "box-build", protocolVersion: 1 } as const

const binding = (assignmentId: string, generation: number) =>
  Schema.decodeSync(WorkspaceBinding)({
    workspaceId: "box-workspace",
    assignmentId,
    generation,
    placement: { _tag: "Orb", workspaceId: "box-workspace", lineageId: "box-lineage" },
    buildId: expected.buildId,
    protocolVersion: expected.protocolVersion,
  })

const firstBinding = binding("box-assignment-1", 1)
const secondBinding = binding("box-assignment-2", 2)

interface MountedConnection {
  readonly id: string
  readonly server: WorkspaceExecutorWebSocketServer
  readonly ticket: string
  socket?: Bun.ServerWebSocket<{ readonly mountId: string }>
}

const loopbackHarness = Effect.gen(function* () {
  const ownerScope = yield* Effect.scope
  const mounts: Array<MountedConnection> = []
  const consumed = new Set<string>()
  const acceptedHeaders: Array<Readonly<Record<string, string>>> = []
  const closed = new Set<string>()
  const fibers = yield* FiberSet.make<void, never>()
  const run = yield* FiberSet.runtime(fibers)<never>()
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve<{ readonly mountId: string }>({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request, bunServer) => {
          const authorization = request.headers.get("authorization")
          const ticket = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1]
          const mounted = mounts.find((candidate) => candidate.ticket === ticket)
          const expectedUrl = `http://127.0.0.1:${server.port}/api/v2/boxes/${boxId}/executor`
          if (
            mounted === undefined ||
            consumed.has(mounted.ticket) ||
            request.url !== expectedUrl ||
            request.headers.get("sec-websocket-protocol") !== workspaceExecutorWebSocketProtocol
          )
            return new Response("Box enrollment required", { status: 401 })
          consumed.add(mounted.ticket)
          acceptedHeaders.push(Object.fromEntries(request.headers.entries()))
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
  const mount = (workspaceBinding: WorkspaceBinding, ticket: string) =>
    makeWorkspaceExecutorWebSocketServer({
      authorize: () => Effect.succeed(workspaceBinding),
      peer: {
        send: (frame) => mounts.find((candidate) => candidate.ticket === ticket)?.socket?.send(frame),
        close: (code, reason) => mounts.find((candidate) => candidate.ticket === ticket)?.socket?.close(code, reason),
      },
    }).pipe(
      Effect.map((adapter) => {
        const mounted = { id: `mount-${mounts.length}`, server: adapter, ticket }
        mounts.push(mounted)
        return mounted
      }),
      Scope.provide(ownerScope),
      Effect.orDie,
    )
  const awaitReady = (mounted: MountedConnection) => mounted.server.ready.pipe(Effect.timeout("5 seconds"))
  const disconnect = (mounted: MountedConnection) =>
    Effect.sync(() => mounted.socket?.close(1_001, "fixture disconnect"))
  const awaitClosed = (mounted: MountedConnection) =>
    Effect.gen(function* () {
      while (!closed.has(mounted.id)) yield* Effect.sleep("10 millis")
    }).pipe(Effect.timeout("5 seconds"))
  return { acceptedHeaders, awaitClosed, awaitReady, disconnect, mount, mounts, server }
})

const dispatch = (
  workspace: WorkspaceExecutorService,
  workspaceBinding: WorkspaceBinding,
  operationId: string,
  tool: string,
  input: Schema.Json,
) =>
  Effect.gen(function* () {
    const intent = makeNativeOperationIntent({ binding: workspaceBinding, operationId, tool, input })
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

const completed = (evidence: ExecutorEvidence): Schema.Json => {
  expect(evidence.outcome._tag).toBe("Completed")
  return evidence.outcome._tag === "Completed" ? evidence.outcome.result : null
}

const bootstrap = (
  workspaceBinding: WorkspaceBinding,
  workspacePath: string,
  url: string,
  ticket: string,
  expiresAtMillis: number,
) =>
  Schema.decodeSync(BoxBootstrapDocument)({
    version: 1,
    boxId,
    binding: workspaceBinding,
    workspacePath,
    enrollment: { url, ticket, expiresAtMillis },
  })

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context))))

it.live(
  "executes native Orb tools, fails closed on socket loss, and owns shutdown",
  () =>
    withPlatform(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const workspacePath = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-box-executor-" })
          const now = yield* Clock.currentTimeMillis
          const loopback = yield* loopbackHarness
          const url = `ws://127.0.0.1:${loopback.server.port}/api/v2/boxes/${boxId}/executor`
          const firstTicket = `a${"1".repeat(42)}`
          const firstMount = yield* loopback.mount(firstBinding, firstTicket)
          const headers: Array<Readonly<Record<string, string>>> = []
          const first = yield* runBoxExecutor({
            bootstrap: bootstrap(firstBinding, workspacePath, url, firstTicket, now + 60_000),
            expected,
            connect: (endpoint, protocol, requestHeaders) => {
              headers.push(requestHeaders)
              return testWebSocketConstructor(requestHeaders.authorization ?? "")(endpoint, [protocol])
            },
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* loopback.awaitReady(firstMount)

          const bash = yield* dispatch(firstMount.server.executor, firstBinding, "box-bash", "bash", {
            command: "printf box-native > native.txt; printf complete",
          })
          expect(completed(bash)).toMatchObject({ text: "complete", exitCode: 0 })
          expect(
            completed(
              yield* dispatch(firstMount.server.executor, firstBinding, "box-read", "read", {
                path: "native.txt",
              }),
            ),
          ).toMatchObject({ text: "1: box-native" })

          const lostInput = {
            command:
              "printf started > lost.txt; while [ ! -f release-lost ]; do sleep 0.01; done; printf finished >> lost.txt",
            timeout_ms: 0,
          }
          const lost = yield* dispatch(firstMount.server.executor, firstBinding, "box-lost", "bash", lostInput).pipe(
            Effect.forkChild,
          )
          yield* awaitFile(fileSystem, `${workspacePath}/lost.txt`, "started")
          yield* loopback.disconnect(firstMount)
          expect(yield* Effect.result(Fiber.join(lost).pipe(Effect.timeout("5 seconds")))).toMatchObject({
            _tag: "Failure",
            failure: { phase: "after-dispatch" },
          })
          expect(yield* Effect.result(Fiber.join(first).pipe(Effect.timeout("5 seconds")))).toMatchObject({
            _tag: "Failure",
            failure: { phase: "reconnect" },
          })
          yield* fileSystem.writeFileString(`${workspacePath}/release-lost`, "release")
          yield* Effect.sleep("250 millis")
          expect(yield* fileSystem.readFileString(`${workspacePath}/lost.txt`)).toBe("started")
          expect(loopback.mounts).toHaveLength(1)

          const secondTicket = `b${"2".repeat(42)}`
          const secondMount = yield* loopback.mount(secondBinding, secondTicket)
          const second = yield* runBoxExecutor({
            bootstrap: bootstrap(secondBinding, workspacePath, url, secondTicket, now + 60_000),
            expected,
            connect: (endpoint, protocol, requestHeaders) => {
              headers.push(requestHeaders)
              return testWebSocketConstructor(requestHeaders.authorization ?? "")(endpoint, [protocol])
            },
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* loopback.awaitReady(secondMount)
          const shutdown = yield* dispatch(secondMount.server.executor, secondBinding, "box-shutdown", "bash", {
            command:
              "printf started > shutdown.txt; while [ ! -f release-shutdown ]; do sleep 0.01; done; printf finished >> shutdown.txt",
            timeout_ms: 0,
          }).pipe(Effect.forkChild)
          yield* awaitFile(fileSystem, `${workspacePath}/shutdown.txt`, "started")
          yield* Fiber.interrupt(second)
          yield* loopback.awaitClosed(secondMount)
          yield* fileSystem.writeFileString(`${workspacePath}/release-shutdown`, "release")
          yield* Effect.sleep("250 millis")
          expect(yield* fileSystem.readFileString(`${workspacePath}/shutdown.txt`)).toBe("started")
          expect((yield* Fiber.await(shutdown))._tag).toBe("Failure")
          expect(headers).toEqual([
            { authorization: `Bearer ${firstTicket}` },
            { authorization: `Bearer ${secondTicket}` },
          ])
          expect(loopback.acceptedHeaders.every((value) => value.dpop === undefined)).toBe(true)
        }),
      ),
    ),
  30_000,
)
