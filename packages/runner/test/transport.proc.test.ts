/* oxlint-disable max-lines, effecttsgo/strict-effect-provide -- the fixture owns a real loopback socket and scoped Runner runtime. */

import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import {
  HandshakeRequest,
  WorkspaceBinding,
  WorkspaceExecutor,
  makeWorkspaceExecutorWebSocketServer,
  toEvidence,
  workspaceExecutorWebSocketProtocol,
  type ExecutorEvidence,
  type ExecutorFenceError,
  type ExecutorTransportError,
  type WorkspaceExecutorService,
  type WorkspaceExecutorWebSocketServer,
} from "@rika/execution"
import { Context, Effect, Fiber, FiberSet, FileSystem, Layer, Ref, Schema, Scope } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { it } from "@effect/vitest"
import { expect } from "vitest"

import { scriptedSearchProvider } from "../src/search"
import { connectRunnerWebSocket, type RunnerWebSocketConnection } from "../src/transport"
import { localWorkspaceExecutorLayer, makeNativeOperationIntent } from "../src/workspace"

const binding = Schema.decodeSync(WorkspaceBinding)({
  workspaceId: "loopback-workspace",
  assignmentId: "loopback-assignment",
  generation: 1,
  placement: {
    _tag: "Runner",
    workspaceId: "loopback-workspace",
    checkoutFingerprint: "loopback-checkout",
  },
  buildId: "loopback-build",
  protocolVersion: 1,
})

const staleBinding = Schema.decodeSync(WorkspaceBinding)({
  ...binding,
  generation: 2,
})

interface MountedConnection {
  adapter?: WorkspaceExecutorWebSocketServer
  socket?: Bun.ServerWebSocket<{ readonly mountId: string }>
}

interface LoopbackHarness {
  readonly authorized: Ref.Ref<number>
  readonly connect: (
    mountId: string,
    workspace: WorkspaceExecutorService,
  ) => Effect.Effect<RunnerWebSocketConnection, ExecutorTransportError, Scope.Scope>
  readonly disconnect: (mountId: string) => Effect.Effect<void>
  readonly mount: (
    authorizedBinding: WorkspaceBinding,
  ) => Effect.Effect<
    { readonly id: string; readonly server: WorkspaceExecutorWebSocketServer },
    ExecutorTransportError | ExecutorFenceError,
    Scope.Scope
  >
}

const loopbackHarness = Effect.gen(function* () {
  const mounts = new Map<string, MountedConnection>()
  const authorized = yield* Ref.make(0)
  const fibers = yield* FiberSet.make<void, never>()
  const run = yield* FiberSet.runtime(fibers)<never>()
  let nextMount = 0
  const running = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve<{ readonly mountId: string }>({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request, server) => {
          const mountId = new URL(request.url).searchParams.get("mount")
          if (
            mountId === null ||
            !mounts.has(mountId) ||
            request.headers.get("sec-websocket-protocol") !== workspaceExecutorWebSocketProtocol
          )
            return new Response("WebSocket enrollment required", { status: 401 })
          return server.upgrade(request, {
            data: { mountId },
            headers: { "sec-websocket-protocol": workspaceExecutorWebSocketProtocol },
          })
            ? undefined
            : new Response("WebSocket upgrade required", { status: 426 })
        },
        websocket: {
          open: (socket) => {
            const mounted = mounts.get(socket.data.mountId)
            if (mounted !== undefined) mounted.socket = socket
          },
          message: (socket, message) => {
            const adapter = mounts.get(socket.data.mountId)?.adapter
            if (adapter !== undefined)
              run(adapter.receive(message).pipe(Effect.ignore))
          },
          close: (socket) => {
            const adapter = mounts.get(socket.data.mountId)?.adapter
            if (adapter !== undefined) run(adapter.disconnected())
          },
        },
      }),
    ),
    (server) => Effect.tryPromise(() => server.stop(true)),
  )
  const constructor = yield* Socket.WebSocketConstructor
  const mount = (authorizedBinding: WorkspaceBinding) =>
    Effect.gen(function* () {
      const id = `mount-${nextMount}`
      nextMount += 1
      const mounted: MountedConnection = {}
      mounts.set(id, mounted)
      const adapter = yield* makeWorkspaceExecutorWebSocketServer({
        authorize: () => Ref.update(authorized, (count) => count + 1).pipe(Effect.as(authorizedBinding)),
        peer: {
          send: (frame) => {
            mounted.socket?.send(frame)
          },
          close: (code, reason) => {
            mounted.socket?.close(code, reason)
          },
        },
      })
      mounted.adapter = adapter
      return { id, server: adapter }
    })
  const connect = (mountId: string, workspace: WorkspaceExecutorService) =>
    connectRunnerWebSocket({
      workspace,
      connect: () =>
        constructor(`ws://127.0.0.1:${running.port}/?mount=${encodeURIComponent(mountId)}`, [
          workspaceExecutorWebSocketProtocol,
        ]),
    })
  return {
    authorized,
    connect,
    mount,
    disconnect: (mountId: string) =>
      Effect.sync(() => {
        mounts.get(mountId)?.socket?.close(1001, "test observer disconnected")
      }),
  } satisfies LoopbackHarness
})

const unreachableWorkspace = (workspaceBinding: WorkspaceBinding): WorkspaceExecutorService => ({
  binding: workspaceBinding,
  handshake: () => Effect.die("invalid enrollment reached handshake"),
  dispatch: () => Effect.die("invalid enrollment reached dispatch"),
  receipt: () => Effect.die("invalid enrollment reached receipt"),
  cancel: () => Effect.die("invalid enrollment reached cancel"),
})

const dispatch = (
  workspace: WorkspaceExecutorService,
  operationId: string,
  tool: string,
  input: Schema.Json,
) =>
  Effect.gen(function* () {
    const intent = makeNativeOperationIntent({ binding, operationId, tool, input })
    const handshake = yield* workspace.handshake(HandshakeRequest.make({ binding }))
    return yield* workspace.dispatch(intent, input, handshake)
  })

const completed = (evidence: ExecutorEvidence): Schema.Json => {
  expect(evidence.outcome._tag).toBe("Completed")
  return evidence.outcome._tag === "Completed" ? evidence.outcome.result : null
}

const awaitFile = (fileSystem: FileSystem.FileSystem, path: string, expected: string) =>
  Effect.gen(function* () {
    while (true) {
      if ((yield* fileSystem.exists(path)) && (yield* fileSystem.readFileString(path)) === expected) return
      yield* Effect.sleep("10 millis")
    }
  }).pipe(Effect.timeout("2 seconds"))

it.live(
  "dispatches every native Tool through a fenced loopback WebSocket without replaying lost responses",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const checkout = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-runner-loopback-" })
        yield* fileSystem.writeFileString(`${checkout}/fixture.txt`, "before\n")
        yield* fileSystem.writeFileString(`${checkout}/editable.txt`, "before\n")
        yield* fileSystem.writeFileString(`${checkout}/gated.txt`, "before\n")
        const workspaceContext = yield* Layer.build(
          localWorkspaceExecutorLayer({
            checkout,
            binding,
            searchProvider: scriptedSearchProvider({
              results: new Map([
                [
                  "Effect",
                  [
                    {
                      title: "Effect",
                      url: "https://effect.website",
                      snippet: "Typed functional effect system",
                    },
                  ],
                ],
              ]),
            }),
          }),
        )
        const local = Context.get(workspaceContext, WorkspaceExecutor)
        const loopback = yield* loopbackHarness
        const first = yield* loopback.mount(binding)
        const firstClient = yield* loopback.connect(first.id, local)
        yield* firstClient.ready.pipe(Effect.timeout("5 seconds"))
        yield* first.server.ready.pipe(Effect.timeout("5 seconds"))

        expect(completed(yield* dispatch(first.server.executor, "operation-bash", "bash", { command: "printf ws-bash" }))).toMatchObject({
          text: "ws-bash",
          exitCode: 0,
        })
        expect(completed(yield* dispatch(first.server.executor, "operation-read", "read", { path: "fixture.txt" }))).toMatchObject({
          text: "1: before\n2: ",
        })
        expect(
          completed(
            yield* dispatch(first.server.executor, "operation-grep", "grep", {
              pattern: "before",
              glob: "fixture.txt",
            }),
          ),
        ).toMatchObject({ text: "fixture.txt:1:before" })
        const edited = yield* Schema.decodeUnknownEffect(Schema.Struct({ diff: Schema.String }))(
          completed(
            yield* dispatch(first.server.executor, "operation-edit", "edit", {
              path: "editable.txt",
              old_str: "before",
              new_str: "after",
            }),
          ),
        )
        expect(edited.diff).toContain("+after")
        expect(
          completed(
            yield* dispatch(first.server.executor, "operation-search", "web_search", { query: "Effect" }),
          ),
        ).toMatchObject({ provider: "scripted", sourceUrls: ["https://effect.website"] })

        const staleHandshake = yield* Effect.result(
          first.server.executor.handshake(HandshakeRequest.make({ binding: staleBinding })),
        )
        expect(staleHandshake).toMatchObject({ _tag: "Failure", failure: { reason: "generation" } })
        const invalid = yield* loopback.mount(binding)
        const invalidClient = yield* loopback.connect(invalid.id, unreachableWorkspace(staleBinding))
        expect(yield* Effect.result(invalidClient.ready.pipe(Effect.timeout("5 seconds")))).toMatchObject({
          _tag: "Failure",
          failure: { phase: "connection" },
        })
        expect(yield* Effect.result(invalid.server.ready.pipe(Effect.timeout("5 seconds")))).toMatchObject({
          _tag: "Failure",
          failure: { reason: "generation" },
        })

        const lostInput = {
          command:
            "printf once >> lost-effect.txt; while [ ! -f release-lost-effect ]; do sleep 0.01; done; printf finished",
          timeout_ms: 0,
        }
        const lostIntent = makeNativeOperationIntent({
          binding,
          operationId: "operation-lost-response",
          tool: "bash",
          input: lostInput,
        })
        const lostHandshake = yield* first.server.executor.handshake(HandshakeRequest.make({ binding }))
        const lost = yield* Effect.forkChild(first.server.executor.dispatch(lostIntent, lostInput, lostHandshake))
        yield* awaitFile(fileSystem, `${checkout}/lost-effect.txt`, "once")
        yield* loopback.disconnect(first.id)
        expect(yield* Effect.result(Fiber.join(lost).pipe(Effect.timeout("5 seconds")))).toMatchObject({
          _tag: "Failure",
          failure: { phase: "after-dispatch" },
        })
        const gatedEdit = yield* Effect.forkChild(
          dispatch(local, "operation-gated-edit", "edit", {
            path: "gated.txt",
            old_str: "before",
            new_str: "after",
          }),
        )
        yield* Effect.sleep("50 millis")
        expect(yield* fileSystem.readFileString(`${checkout}/gated.txt`)).toBe("before\n")
        expect(yield* local.receipt("operation-gated-edit")).toBeUndefined()
        yield* fileSystem.writeFileString(`${checkout}/release-lost-effect`, "release\n")
        const retained = yield* Effect.gen(function* () {
          while (true) {
            const receipt = yield* local.receipt(lostIntent.operationId)
            if (receipt !== undefined) return receipt
            yield* Effect.sleep("10 millis")
          }
        }).pipe(Effect.timeout("5 seconds"))
        expect(completed(retained)).toMatchObject({ text: "finished", exitCode: 0 })
        expect(yield* Fiber.join(gatedEdit).pipe(Effect.timeout("5 seconds"))).toMatchObject({
          outcome: { _tag: "Completed" },
        })
        expect(yield* fileSystem.readFileString(`${checkout}/lost-effect.txt`)).toBe("once")
        expect(yield* fileSystem.readFileString(`${checkout}/gated.txt`)).toBe("after\n")

        const second = yield* loopback.mount(binding)
        const secondClient = yield* loopback.connect(second.id, local)
        yield* secondClient.ready.pipe(Effect.timeout("5 seconds"))
        const reconnected = yield* second.server.executor.receipt(lostIntent.operationId)
        expect(reconnected).toEqual(retained)
        const cached = yield* second.server.executor.dispatch(lostIntent, lostInput, toEvidence(binding))
        expect(cached).toEqual(retained)
        expect(yield* fileSystem.readFileString(`${checkout}/lost-effect.txt`)).toBe("once")

        const cancelInput = {
          command: "printf started > cancel-effect.txt; sleep 60; printf finished >> cancel-effect.txt",
          timeout_ms: 60_000,
        }
        const cancelIntent = makeNativeOperationIntent({
          binding,
          operationId: "operation-cancel",
          tool: "bash",
          input: cancelInput,
        })
        const cancelHandshake = yield* second.server.executor.handshake(HandshakeRequest.make({ binding }))
        const running = yield* Effect.forkChild(
          second.server.executor.dispatch(cancelIntent, cancelInput, cancelHandshake),
        )
        yield* awaitFile(fileSystem, `${checkout}/cancel-effect.txt`, "started")
        expect(yield* second.server.executor.cancel(cancelIntent.operationId)).toEqual({ _tag: "Cancelled" })
        expect(yield* Fiber.join(running).pipe(Effect.timeout("5 seconds"))).toMatchObject({
          outcome: { _tag: "Unknown" },
        })
        yield* Effect.sleep("100 millis")
        expect(yield* fileSystem.readFileString(`${checkout}/cancel-effect.txt`)).toBe("started")
        expect(yield* Ref.get(loopback.authorized)).toBe(3)
      }),
    ).pipe(Effect.provide(Layer.merge(BunServices.layer, BunSocket.layerWebSocketConstructor))),
  30_000,
)
