import { Effect, Schema } from "effect"
import type { IdentityConfig } from "@rika/identity"
import { ClientMessage, ServerFrame } from "@rika/product/client-protocol"
import type { Gateway, Socket } from "../executor-gateway"
import { isRikaApiPath, makeRikaApiHandler } from "../api"
import { threadWebSocketAudience, type HostedThreadConnection } from "../hosted-thread-protocol"
import { makeSupplementalApiRequestHandler, secureResponse, type HttpDependencies } from "../http"

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

type SessionGateway = Pick<Gateway, "receive" | "disconnected" | "active">

interface Session {
  readonly attach: (socket: Bun.ServerWebSocket<Session>) => void
  readonly receive: (socket: Socket, message: unknown) => void
  readonly disconnected: (socket: Socket) => void
  readonly validate: () => Effect.Effect<boolean>
  readonly drain: () => Promise<void>
  readonly close: (code?: number, reason?: string) => void
}

interface AuthoritySession {
  readonly validate: () => Effect.Effect<boolean>
  readonly close: (code?: number, reason?: string) => void
}

export const pollAuthority = (sessions: ReadonlySet<AuthoritySession>) =>
  Effect.sleep("100 millis").pipe(
    Effect.andThen(
      Effect.suspend(() =>
        Effect.forEach(
          sessions,
          (current) =>
            current
              .validate()
              .pipe(
                Effect.tap((active) =>
                  active ? Effect.void : Effect.sync(() => current.close(1008, "authority revoked")),
                ),
              ),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
    Effect.forever,
  )

const session = (gateway: SessionGateway): Session => {
  let pending: Promise<unknown> = Promise.resolve()
  const concurrent = new Set<Promise<unknown>>()
  let activeSocket: Bun.ServerWebSocket<Session> | undefined
  let draining = false
  const reverse = (message: unknown) => {
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer)
      const tag = (JSON.parse(text) as { readonly _tag?: unknown })._tag
      return tag === "BindingInvoke" || tag === "MachineResult"
    } catch {
      return false
    }
  }
  return {
    attach: (socket) => {
      activeSocket = socket
    },
    receive: (socket, message) => {
      if (draining) return
      if (reverse(message)) {
        const task = Effect.runPromise(gateway.receive(socket, message)).catch(() => undefined)
        concurrent.add(task)
        void task.finally(() => concurrent.delete(task))
        return
      }
      pending = pending.then(() => Effect.runPromise(gateway.receive(socket, message))).catch(() => undefined)
    },
    disconnected: (socket) => {
      pending = pending.then(() => Effect.runPromise(gateway.disconnected(socket))).catch(() => undefined)
    },
    validate: () =>
      activeSocket === undefined
        ? Effect.succeed(true)
        : gateway.active(activeSocket).pipe(Effect.orElseSucceed(() => false)),
    drain: () => {
      draining = true
      return pending.then(() => Promise.all(concurrent)).then(() => undefined)
    },
    close: (code = 1001, reason = "server draining") => activeSocket?.close(code, reason),
  }
}

const decodeThreadMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientMessage))
const encodeThreadFrame = Schema.encodeSync(Schema.fromJsonString(ServerFrame))

const threadSession = (connection: HostedThreadConnection): Session => {
  let pending: Promise<unknown> = Promise.resolve()
  let activeSocket: Bun.ServerWebSocket<Session> | undefined
  let draining = false
  return {
    attach: (socket) => {
      activeSocket = socket
    },
    receive: (socket, message) => {
      if (draining) return
      const body = typeof message === "string" ? message : Buffer.from(message as Uint8Array).toString("utf8")
      pending = pending
        .then(() =>
          Effect.runPromise(
            decodeThreadMessage(body).pipe(
              Effect.flatMap(connection.receive),
              Effect.tap((frames) =>
                Effect.sync(() => frames.forEach((current) => socket.send(encodeThreadFrame(current)))),
              ),
            ),
          ),
        )
        .catch(() => socket.close(1003, "invalid Thread protocol frame"))
    },
    disconnected: () => {
      pending = pending.then(() => Effect.runPromise(connection.detach)).catch(() => undefined)
    },
    validate: () => connection.active.pipe(Effect.orElseSucceed(() => false)),
    drain: () => {
      draining = true
      return pending.then(() => undefined)
    },
    close: (code = 1001, reason = "server draining") => activeSocket?.close(code, reason),
  }
}

const threadTicket = (request: Request) => {
  const offered = request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((value) => value.trim())
  if (offered?.includes("rika.thread.v1") !== true) return undefined
  return offered.find((value) => value.startsWith("rika.ticket."))?.slice("rika.ticket.".length)
}

export const serveApi = (input: { readonly config: IdentityConfig; readonly dependencies: HttpDependencies }) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const api = makeRikaApiHandler(input.dependencies)
      const sessions = new Set<Session>()
      const idleWaiters = new Set<() => void>()
      let activeRequests = 0
      const track = <A>(response: Promise<A>) => {
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
      const supplementalApi = makeSupplementalApiRequestHandler(input.dependencies)
      const server = Bun.serve<Session>({
        hostname: "0.0.0.0",
        port: input.config.port,
        fetch: (request, bunServer) => {
          const pathname = new URL(request.url).pathname
          if (pathname === threadWebSocketAudience) {
            if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
            const ticket = threadTicket(request)
            if (ticket === undefined || input.dependencies.threads === undefined)
              return new Response("WebSocket authentication required", { status: 401 })
            return track(
              Effect.runPromise(input.dependencies.threads.connect(ticket, threadWebSocketAudience))
                .then((connection) =>
                  bunServer.upgrade(request, {
                    data: threadSession(connection),
                    headers: { "sec-websocket-protocol": "rika.thread.v1" },
                  })
                    ? undefined
                    : new Response("WebSocket upgrade required", { status: 426 }),
                )
                .catch(() => new Response("WebSocket authentication required", { status: 401 })),
            )
          }
          if (pathname === "/api/v1/executors" || pathname === "/api/v1/runners") {
            if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
            const gateway =
              pathname === "/api/v1/executors"
                ? input.dependencies.executor.gateway
                : input.dependencies.executor.runnerGateway
            return bunServer.upgrade(request, { data: session(gateway) })
              ? undefined
              : new Response("WebSocket upgrade required", { status: 426 })
          }
          const publicRequest = canonicalPublicRequest({ request, baseUrl: input.config.baseUrl })
          if (isRikaApiPath(pathname))
            return track(api.handler(publicRequest).then(secureResponse(input.dependencies.production)))
          return track(Promise.resolve(supplementalApi(publicRequest)))
        },
        websocket: {
          open: (socket) => {
            socket.data!.attach(socket)
            sessions.add(socket.data!)
          },
          message: (socket, message) => socket.data!.receive(socket, message),
          close: (socket) => {
            sessions.delete(socket.data!)
            socket.data!.disconnected(socket)
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
  ).pipe(
    Effect.tap((resources) => pollAuthority(resources.sessions).pipe(Effect.forkScoped({ startImmediately: true }))),
  )
