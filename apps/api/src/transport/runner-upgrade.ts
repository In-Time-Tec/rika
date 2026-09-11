import { Effect, Exit, Schema, Scope } from "effect"
import {
  workspaceExecutorWebSocketProtocol,
  defaultWorkspaceExecutorTransportLimits,
  type WorkspaceExecutorWebSocketPeer,
  type WorkspaceExecutorWebSocketData,
  type WorkspaceExecutorWebSocketServer,
} from "@rika/execution"
import type { RunnerGateway } from "../executor/runner-gateway"

export interface RunnerUpgrade {
  readonly connection: WorkspaceExecutorWebSocketServer
  readonly opened: (peer: WorkspaceExecutorWebSocketPeer) => Effect.Effect<void>
  readonly receive: (frame: WorkspaceExecutorWebSocketData) => Effect.Effect<void>
  readonly close: Effect.Effect<void>
}

export const runnerThreadPath = (request: Request) => {
  if (request.method !== "GET") return undefined
  const match = /^\/api\/v2\/threads\/([^/]+)\/executor$/.exec(new URL(request.url).pathname)
  if (match?.[1] === undefined) return undefined
  try {
    return decodeURIComponent(match[1])
  } catch {
    return undefined
  }
}

export const prepareRunnerUpgrade = Effect.fn("Rika.RunnerUpgrade.prepare")(function* (input: {
  readonly request: Request
  readonly threadId: string
  readonly gateway: RunnerGateway
}) {
  const protocols = input.request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((part) => part.trim())
  if (protocols?.includes(workspaceExecutorWebSocketProtocol) !== true)
    return new Response("Workspace Executor protocol required", { status: 426 })
  const scope = yield* Scope.make()
  let peer: WorkspaceExecutorWebSocketPeer | undefined
  let closing: { readonly code: number; readonly reason: string } | undefined
  const result = yield* input.gateway
    .connect({
      request: input.request,
      threadId: input.threadId,
      peer: {
        send: (frame) => {
          if (peer === undefined) throw new Error("Runner socket is not open")
          peer.send(frame)
        },
        close: (code, reason) => {
          if (closing !== undefined) return
          closing = { code, reason }
          peer?.close(code, reason)
        },
      },
    })
    .pipe(
      Scope.provide(scope),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
      Effect.result,
    )
  if (result._tag === "Failure") {
    yield* Scope.close(scope, Exit.void)
    let status = 503
    if (result.failure._tag === "RikaRunnerConnectionError") {
      if (result.failure.kind === "unauthorized") status = 401
      else if (result.failure.kind === "forbidden") status = 403
    } else if (result.failure._tag === "RikaExecutionV2ExecutorFenceError") status = 409
    return new Response("Runner connection rejected", { status, headers: { "cache-control": "no-store" } })
  }
  const connection = result.success
  const limits = defaultWorkspaceExecutorTransportLimits
  let pendingFrames = 0
  let pendingBytes = 0
  yield* connection.ready.pipe(
    Effect.timeout("10 seconds"),
    Effect.catch(() => connection.disconnected()),
    Effect.forkIn(scope),
  )
  return {
    connection,
    opened: (socket) =>
      Effect.sync(() => {
        peer = socket
        if (closing !== undefined) socket.close(closing.code, closing.reason)
      }),
    receive: (frame) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          if (closing !== undefined) return
          const bytes = Schema.is(Schema.String)(frame) ? new TextEncoder().encode(frame).byteLength : frame.byteLength
          if (
            bytes > limits.maxFrameBytes ||
            pendingFrames >= limits.maxInFlightRpcs ||
            pendingBytes + bytes > limits.maxInFlightBytes
          ) {
            yield* connection.disconnected()
            return
          }
          pendingFrames += 1
          pendingBytes += bytes
          yield* restore(connection.receive(frame)).pipe(
            Effect.ignore,
            Effect.ensuring(
              Effect.sync(() => {
                pendingFrames -= 1
                pendingBytes -= bytes
              }),
            ),
            Effect.forkIn(scope),
          )
        }),
      ),
    close: connection.disconnected().pipe(Effect.ensuring(Scope.close(scope, Exit.void))),
  } satisfies RunnerUpgrade
})
