import { Effect } from "effect"
import type { IdentityConfig } from "@rika/identity"
import type { Gateway, Socket } from "../executor-gateway"
import { isControlPlaneApiPath, makeControlPlaneApiHandler } from "../api"
import { makeWebRequestHandler, secureResponse, type HttpDependencies } from "../http"

interface Session {
  readonly receive: (socket: Socket, message: unknown) => void
}

const session = (gateway: Gateway): Session => {
  let pending = Promise.resolve()
  return {
    receive: (socket, message) => {
      pending = pending.then(() => Effect.runPromise(gateway.receive(socket, message))).catch(() => undefined)
    },
  }
}

export const serveControlPlane = (input: {
  readonly config: IdentityConfig
  readonly dependencies: HttpDependencies
}) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const api = makeControlPlaneApiHandler(input.dependencies)
      const server = Bun.serve<Session>({
        hostname: "0.0.0.0",
        port: input.config.port,
        fetch: (request, bunServer) => {
          const pathname = new URL(request.url).pathname
          if (pathname === "/api/v1/executors") {
            if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
            return bunServer.upgrade(request, { data: session(input.dependencies.executor.gateway) })
              ? undefined
              : new Response("WebSocket upgrade required", { status: 426 })
          }
          if (isControlPlaneApiPath(pathname))
            return api.handler(request).then(secureResponse(input.dependencies.production))
          return makeWebRequestHandler(input.dependencies)(request)
        },
        websocket: {
          message: (socket, message) => socket.data!.receive(socket, message),
          close: (socket) => {
            Effect.runFork(input.dependencies.executor.gateway.disconnected(socket))
          },
        },
      })
      return { api, server }
    }),
    ({ api, server }) =>
      Effect.all([Effect.promise(() => server.stop(true)), Effect.promise(api.dispose)], { discard: true }),
  )
