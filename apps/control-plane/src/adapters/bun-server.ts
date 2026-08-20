import { Effect } from "effect"
import type { IdentityConfig } from "@rika/identity"
import type { Gateway, Socket } from "../executor-gateway"
import { isControlPlaneApiPath, makeControlPlaneApiHandler } from "../api"
import { makeWebRequestHandler, secureResponse, type HttpDependencies } from "../http"

export const canonicalPublicRequest = (input: { readonly request: Request; readonly baseUrl: string }): Request => {
  const incoming = new URL(input.request.url)
  const publicUrl = new URL(input.baseUrl)
  publicUrl.pathname = incoming.pathname
  publicUrl.search = incoming.search
  const headers = new Headers(input.request.headers)
  headers.set("host", publicUrl.host)
  for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto"]) headers.delete(name)
  return new Request(publicUrl.href, {
    method: input.request.method,
    headers,
    signal: input.request.signal,
    ...(input.request.body === null ? {} : { body: input.request.body }),
  })
}

interface Session {
  readonly attach: (socket: Bun.ServerWebSocket<Session>) => void
  readonly receive: (socket: Socket, message: unknown) => void
  readonly drain: () => Promise<void>
  readonly close: () => void
}

const session = (gateway: Gateway): Session => {
  let pending: Promise<unknown> = Promise.resolve()
  let activeSocket: Bun.ServerWebSocket<Session> | undefined
  let draining = false
  return {
    attach: (socket) => {
      activeSocket = socket
    },
    receive: (socket, message) => {
      if (draining) return
      pending = pending.then(() => Effect.runPromise(gateway.receive(socket, message))).catch(() => undefined)
    },
    drain: () => {
      draining = true
      return pending.then(() => undefined)
    },
    close: () => activeSocket?.close(1001, "server draining"),
  }
}

export const serveControlPlane = (input: {
  readonly config: IdentityConfig
  readonly dependencies: HttpDependencies
}) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const api = makeControlPlaneApiHandler(input.dependencies)
      const sessions = new Set<Session>()
      const idleWaiters = new Set<() => void>()
      let activeRequests = 0
      const track = (response: Promise<Response>) => {
        activeRequests += 1
        return response.finally(() => {
          activeRequests -= 1
          if (activeRequests === 0) {
            for (const resolve of idleWaiters) resolve()
            idleWaiters.clear()
          }
        })
      }
      const waitForRequests = Effect.callback<void>((resume) => {
        if (activeRequests === 0) {
          resume(Effect.void)
          return Effect.void
        }
        const resolve = () => resume(Effect.void)
        idleWaiters.add(resolve)
        return Effect.sync(() => {
          idleWaiters.delete(resolve)
        })
      })
      const web = makeWebRequestHandler(input.dependencies)
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
          const publicRequest = canonicalPublicRequest({ request, baseUrl: input.config.baseUrl })
          if (isControlPlaneApiPath(pathname))
            return track(api.handler(publicRequest).then(secureResponse(input.dependencies.production)))
          return track(Promise.resolve(web(publicRequest)))
        },
        websocket: {
          open: (socket) => {
            socket.data!.attach(socket)
            sessions.add(socket.data!)
          },
          message: (socket, message) => socket.data!.receive(socket, message),
          close: (socket) => {
            sessions.delete(socket.data!)
            Effect.runFork(input.dependencies.executor.gateway.disconnected(socket))
          },
        },
      })
      return { api, server, sessions, waitForRequests }
    }),
    ({ api, server, sessions, waitForRequests }) =>
      Effect.gen(function* () {
        const stopped = server.stop()
        yield* waitForRequests
        yield* Effect.promise(() => Promise.all(Array.from(sessions, (current) => current.drain())))
        for (const current of sessions) current.close()
        yield* Effect.promise(() => stopped)
        yield* Effect.promise(api.dispose)
      }),
  )
