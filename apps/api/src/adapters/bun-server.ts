import { Deferred, Effect, Exit, FiberSet, Queue, Schema, Scope } from "effect"
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
  readonly disconnected: (socket: Socket) => Effect.Effect<void>
  readonly validate: () => Effect.Effect<boolean>
  readonly stopAdmission: () => void
  readonly drain: () => Effect.Effect<void>
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

const ownedSession = (handler: {
  readonly receive: (socket: Socket, message: unknown) => Effect.Effect<void>
  readonly disconnected: (socket: Socket | undefined) => Effect.Effect<void>
  readonly active: (socket: Socket) => Effect.Effect<boolean>
  readonly concurrent?: (message: unknown) => boolean
}): Session => {
  const scope = Scope.makeUnsafe("parallel")
  const fibers = Effect.runSync(FiberSet.make<void, never>().pipe(Effect.provideService(Scope.Scope, scope)))
  const run = Effect.runSync(FiberSet.runtime(fibers)<never>())
  const serial = Effect.runSync(Queue.unbounded<Effect.Effect<void>>())
  run(
    Queue.take(serial).pipe(
      Effect.flatMap((receive) => receive),
      Effect.forever,
    ),
  )
  const closed = Deferred.makeUnsafe<void>()
  let activeSocket: Bun.ServerWebSocket<Session> | undefined
  let accepting = true
  let closing = false
  const stop = (socket: Socket | undefined) =>
    Effect.suspend(() => {
      accepting = false
      if (closing) return Deferred.await(closed)
      closing = true
      return Scope.close(scope, Exit.void).pipe(
        Effect.andThen(handler.disconnected(socket)),
        Effect.ensuring(Deferred.succeed(closed, undefined)),
      )
    })
  return {
    attach: (socket) => {
      activeSocket = socket
    },
    receive: (socket, message) => {
      if (!accepting) return
      const receive = handler.receive(socket, message).pipe(Effect.ignore)
      if (handler.concurrent?.(message) === true) run(receive)
      else Queue.offerUnsafe(serial, receive)
    },
    disconnected: (socket) => {
      accepting = false
      return stop(socket)
    },
    validate: () =>
      !accepting || activeSocket === undefined
        ? Effect.succeed(true)
        : handler.active(activeSocket).pipe(Effect.orElseSucceed(() => false)),
    stopAdmission: () => {
      accepting = false
    },
    drain: () => stop(activeSocket),
    close: (code = 1001, reason = "server draining") => activeSocket?.close(code, reason),
  }
}

const ReverseMessage = Schema.fromJsonString(
  Schema.Struct({ _tag: Schema.Literals(["BindingInvoke", "MachineResult"]), payload: Schema.optional(Schema.Unknown) }),
)
const decodeReverseMessage = Schema.decodeUnknownExit(ReverseMessage)

const reverse = (message: unknown) => {
  const text = typeof message === "string" ? message : new TextDecoder().decode(message as ArrayBuffer)
  return Exit.isSuccess(decodeReverseMessage(text))
}

const session = (gateway: SessionGateway): Session =>
  ownedSession({
    receive: gateway.receive,
    disconnected: (socket) => (socket === undefined ? Effect.void : gateway.disconnected(socket)),
    active: gateway.active,
    concurrent: reverse,
  })

const decodeThreadMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientMessage))
const encodeThreadFrame = Schema.encodeSync(Schema.fromJsonString(ServerFrame))

const threadSession = (connection: HostedThreadConnection): Session =>
  ownedSession({
    receive: (socket, message) => {
      const body = typeof message === "string" ? message : Buffer.from(message as Uint8Array).toString("utf8")
      return decodeThreadMessage(body).pipe(
        Effect.flatMap(connection.receive),
        Effect.tap((frames) => Effect.sync(() => frames.forEach((current) => socket.send(encodeThreadFrame(current))))),
        Effect.asVoid,
        Effect.catch(() => Effect.sync(() => socket.close(1003, "invalid Thread protocol frame"))),
      )
    },
    disconnected: () => connection.detach,
    active: () => connection.active,
  })

const threadTicket = (request: Request) => {
  const offered = request.headers
    .get("sec-websocket-protocol")
    ?.split(",")
    .map((value) => value.trim())
  if (offered?.includes("rika.thread.v1") !== true) return undefined
  return offered.find((value) => value.startsWith("rika.ticket."))?.slice("rika.ticket.".length)
}

const bridgePromise = Effect.promise

export const serveApi = (input: { readonly config: IdentityConfig; readonly dependencies: HttpDependencies }) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const sessionClosureScope = Scope.makeUnsafe("parallel")
      const sessionClosures = yield* FiberSet.make<void, never>().pipe(
        Effect.provideService(Scope.Scope, sessionClosureScope),
      )
      const runSessionClose = yield* FiberSet.runtime(sessionClosures)<never>()
      const context = yield* Effect.context<never>()
      return yield* Effect.sync(() => {
        const api = makeRikaApiHandler(input.dependencies)
        const sessions = new Set<Session>()
        const idleWaiters = new Set<() => void>()
        let activeRequests = 0
        let stopping = false
        const track = <A, E, R>(request: Effect.Effect<A, E, R>) =>
          Effect.acquireUseRelease(
            Effect.sync(() => {
              activeRequests += 1
            }),
            () => request,
            () =>
              Effect.sync(() => {
                activeRequests -= 1
                if (activeRequests === 0) {
                  for (const resolve of idleWaiters) resolve()
                  idleWaiters.clear()
                }
              }),
          )
        const runRequest = <A>(request: Effect.Effect<A, never, never>) =>
          track(request).pipe(Effect.runPromiseWith(context))
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
            if (stopping) return new Response("Server stopping", { status: 503 })
            const pathname = new URL(request.url).pathname
            if (pathname === threadWebSocketAudience) {
              if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
              const ticket = threadTicket(request)
              if (ticket === undefined || input.dependencies.threads === undefined)
                return new Response("WebSocket authentication required", { status: 401 })
              return runRequest(
                input.dependencies.threads.connect(ticket, threadWebSocketAudience).pipe(
                  Effect.map((connection) => {
                    if (stopping) return new Response("Server stopping", { status: 503 })
                    const current = threadSession(connection)
                    sessions.add(current)
                    if (
                      bunServer.upgrade(request, {
                        data: current,
                        headers: { "sec-websocket-protocol": "rika.thread.v1" },
                      })
                    )
                      return undefined
                    sessions.delete(current)
                    runSessionClose(current.drain())
                    return new Response("WebSocket upgrade required", { status: 426 })
                  }),
                  Effect.orElseSucceed(() => new Response("WebSocket authentication required", { status: 401 })),
                ),
              )
            }
            if (pathname === "/api/v1/executors" || pathname === "/api/v1/runners") {
              if (request.method !== "GET") return new Response("Method not allowed", { status: 405 })
              const gateway =
                pathname === "/api/v1/executors"
                  ? input.dependencies.executor.gateway
                  : input.dependencies.executor.runnerGateway
              const current = session(gateway)
              sessions.add(current)
              if (bunServer.upgrade(request, { data: current })) return undefined
              sessions.delete(current)
              runSessionClose(current.drain())
              return new Response("WebSocket upgrade required", { status: 426 })
            }
            const publicRequest = canonicalPublicRequest({ request, baseUrl: input.config.baseUrl })
            if (isRikaApiPath(pathname))
              return runRequest(
                bridgePromise(() => api.handler(publicRequest)).pipe(
                  Effect.map(secureResponse(input.dependencies.production)),
                ),
              )
            return runRequest(bridgePromise(() => supplementalApi(publicRequest)))
          },
          websocket: {
            open: (socket) => {
              socket.data!.attach(socket)
            },
            message: (socket, message) => socket.data!.receive(socket, message),
            close: (socket) => {
              sessions.delete(socket.data!)
              runSessionClose(socket.data!.disconnected(socket))
            },
          },
        })
        return {
          api,
          server,
          sessions,
          waitForRequests,
          sessionClosureScope,
          sessionClosures,
          runSessionClose,
          stopAdmission: () => {
            stopping = true
          },
        }
      })
    }),
    ({
      api,
      server,
      sessions,
      waitForRequests,
      sessionClosureScope,
      sessionClosures,
      runSessionClose,
      stopAdmission,
    }) =>
      Effect.gen(function* () {
        stopAdmission()
        const stopped = server.stop()
        const draining = [...sessions]
        for (const current of draining) {
          current.stopAdmission()
          runSessionClose(current.drain())
        }
        const graceful = yield* Effect.gen(function* () {
          yield* FiberSet.awaitEmpty(sessionClosures)
          for (const current of draining) current.close()
          yield* FiberSet.awaitEmpty(sessionClosures)
          yield* Effect.all([waitForRequests, bridgePromise(() => stopped)], {
            concurrency: "unbounded",
            discard: true,
          })
        }).pipe(Effect.timeoutOption("5 seconds"))
        if (graceful._tag === "None") {
          for (const current of draining) current.close()
          yield* bridgePromise(() => server.stop(true))
        } else {
          yield* Scope.close(sessionClosureScope, Exit.void)
        }
        yield* bridgePromise(api.dispose)
      }),
  ).pipe(
    Effect.tap((resources) => pollAuthority(resources.sessions).pipe(Effect.forkScoped({ startImmediately: true }))),
  )
