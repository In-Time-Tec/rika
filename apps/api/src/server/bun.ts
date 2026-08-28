import { Deferred, Effect, Exit, FiberSet, Function, Queue, Schema, Scope } from "effect"
import type { IdentityConfig } from "@rika/identity"
import {
  CompatibleClientMessage,
  CompatibleServerFrame,
  ClientMessage,
  type ClientProtocolVersion,
  inspectClientProtocolVersion,
  isSupportedClientProtocolVersion,
  normalizeClientMessage,
  protocolMismatchCloseCode,
  protocolMismatchFrame,
  protocolMismatchMessage,
  protocolVersion,
  ServerFrame,
} from "@rika/product/client-protocol"
import type { Gateway, Socket } from "../executor/gateway"
import * as Api from "../api"
import { threadWebSocketAudience, type HostedThreadConnection } from "../hosted/thread/protocol"
import * as Http from "./http"
import type { HttpDependencies } from "./http"

export const canonicalPublicRequest = (input: { readonly request: Request; readonly baseUrl: string }): Request => {
  const incoming = new URL(input.request.url)
  const publicUrl = new URL(input.baseUrl)
  publicUrl.pathname = incoming.pathname
  publicUrl.search = incoming.search
  const headers = new Headers(input.request.headers)
  headers.set("host", publicUrl.host)
  for (const name of ["forwarded", "x-forwarded-host", "x-forwarded-port", "x-forwarded-proto"]) headers.delete(name)
  const init: RequestInit = {
    method: input.request.method,
    headers,
    signal: input.request.signal,
  }
  if (input.request.body !== null) init.body = input.request.body
  return new Request(publicUrl.href, init)
}

type SessionGateway = Pick<Gateway, "receive" | "disconnected" | "active">
type WebSocketMessage = string | Buffer

interface Session {
  readonly kind: "executor" | "runner" | "thread"
  readonly attach: (socket: Bun.ServerWebSocket<Session>) => void
  readonly receive: (socket: Socket, message: WebSocketMessage) => void
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

const maximumSessionMessages = 1024

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
  readonly kind: Session["kind"]
  readonly opened?: (socket: Socket) => Effect.Effect<void>
  readonly receive: (socket: Socket, message: WebSocketMessage) => Effect.Effect<void>
  readonly disconnected: (socket: Socket | undefined) => Effect.Effect<void>
  readonly active: (socket: Socket) => Effect.Effect<boolean>
  readonly durable?: (message: WebSocketMessage) => boolean
  readonly concurrent?: (message: WebSocketMessage) => boolean
  readonly runConcurrent?: (effect: Effect.Effect<void>) => void
  readonly maximumQueuedBytes?: number
}): Session => {
  const scope = Scope.makeUnsafe("parallel")
  const fibers = Effect.runSync(FiberSet.make<void, never>().pipe(Effect.provideService(Scope.Scope, scope)))
  const run = Effect.runSync(FiberSet.runtime(fibers)<never>())
  const serial = Effect.runSync(Queue.bounded<Effect.Effect<void>>(maximumSessionMessages))
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
  let queuedBytes = 0
  let durableReceives = 0
  const durableDrained = Deferred.makeUnsafe<void>()
  const runDurable = (receive: Effect.Effect<void>) =>
    Effect.suspend(() => {
      durableReceives += 1
      const processed = Deferred.makeUnsafe<void>()
      ;(handler.runConcurrent ?? run)(
        receive.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              durableReceives -= 1
            }).pipe(
              Effect.andThen(Deferred.succeed(processed, undefined)),
              Effect.andThen(
                Effect.suspend(() =>
                  closing && durableReceives === 0 ? Deferred.succeed(durableDrained, undefined) : Effect.void,
                ),
              ),
            ),
          ),
        ),
      )
      return Deferred.await(processed)
    })
  const stop = (socket: Socket | undefined) =>
    Effect.suspend(() => {
      accepting = false
      if (closing) return Deferred.await(closed)
      closing = true
      return Scope.close(scope, Exit.void).pipe(
        Effect.andThen(Effect.suspend(() => (durableReceives === 0 ? Effect.void : Deferred.await(durableDrained)))),
        Effect.andThen(handler.disconnected(socket)),
        Effect.ensuring(Deferred.succeed(closed, undefined)),
      )
    })
  return {
    kind: handler.kind,
    attach: (socket) => {
      activeSocket = socket
      if (handler.opened !== undefined) run(handler.opened(socket))
    },
    receive: (socket, message) => {
      if (!accepting) return
      const bytes = Buffer.byteLength(message)
      if (handler.maximumQueuedBytes !== undefined && queuedBytes + bytes > handler.maximumQueuedBytes) {
        accepting = false
        socket.close(1013, "session byte limit exceeded")
        return
      }
      queuedBytes += bytes
      const receive = handler.receive(socket, message).pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            queuedBytes -= bytes
          }),
        ),
      )
      const owned = handler.durable?.(message) === true ? runDurable(receive) : receive
      if (handler.concurrent?.(message) === true) (handler.runConcurrent ?? run)(owned)
      else if (!Queue.offerUnsafe(serial, owned)) {
        queuedBytes -= bytes
        accepting = false
        socket.close(1013, "session overloaded")
      }
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
  Schema.Struct({
    _tag: Schema.Literals(["BindingInvoke", "MachineResult", "ExecutorConnectionFailed"]),
    payload: Schema.optional(Schema.Unknown),
  }),
)
const decodeReverseMessage = Schema.decodeUnknownExit(ReverseMessage)

const reverse = (message: WebSocketMessage) =>
  Exit.isSuccess(decodeReverseMessage(Buffer.from(message).toString("utf8")))

const DurableMessage = Schema.fromJsonString(
  Schema.Struct({
    _tag: Schema.Literals(["CellLifecycle", "CellResult", "ExecutorConnectionFailed"]),
    payload: Schema.optional(Schema.Unknown),
  }),
)
const decodeDurableMessage = Schema.decodeUnknownExit(DurableMessage)

const durable = (message: WebSocketMessage) =>
  Exit.isSuccess(decodeDurableMessage(Buffer.from(message).toString("utf8")))

const session = (
  kind: "executor" | "runner",
  gateway: SessionGateway,
  runConcurrent: (effect: Effect.Effect<void>) => void,
): Session =>
  ownedSession({
    kind,
    receive: gateway.receive,
    disconnected: (socket) => (socket === undefined ? Effect.void : gateway.disconnected(socket)),
    active: gateway.active,
    durable,
    concurrent: reverse,
    runConcurrent,
  })

const decodeThreadMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(CompatibleClientMessage))
const encodeThreadFrame = Schema.encodeSync(Schema.fromJsonString(ServerFrame))
const encodeCompatibleThreadFrame = Schema.encodeSync(Schema.fromJsonString(CompatibleServerFrame))
const maximumThreadSocketBytes = 32 * 1024 * 1024

interface EncodedThreadFrames {
  readonly values: ReadonlyArray<string>
  readonly bytes: number
}

const encodeThreadFrames = (
  frames: ReadonlyArray<ServerFrame>,
  negotiatedVersion: ClientProtocolVersion = protocolVersion,
): EncodedThreadFrames => {
  const values = frames.map((frame) =>
    negotiatedVersion === protocolVersion
      ? encodeThreadFrame(frame)
      : encodeCompatibleThreadFrame({ ...frame, protocolVersion: negotiatedVersion }),
  )
  return { values, bytes: values.reduce((total, value) => total + Buffer.byteLength(value), 0) }
}

const sendEncodedThreadFrames = (socket: Socket, frames: EncodedThreadFrames) =>
  Effect.sync(() => {
    if ((socket.getBufferedAmount?.() ?? 0) + frames.bytes > maximumThreadSocketBytes) {
      socket.close(1013, "slow Thread consumer")
      return
    }
    for (const encoded of frames.values) socket.send(encoded)
  })

export const sendThreadFrames: {
  (socket: Socket, frames: ReadonlyArray<ServerFrame>): Effect.Effect<void>
  (frames: ReadonlyArray<ServerFrame>): (socket: Socket) => Effect.Effect<void>
} = Function.dual(2, (socket: Socket, frames: ReadonlyArray<ServerFrame>) =>
  sendEncodedThreadFrames(socket, encodeThreadFrames(frames)),
)

const threadSession = (
  connection: HostedThreadConnection,
  runCommand: (effect: Effect.Effect<void>) => void,
): Session => {
  const outbound = Effect.runSync(Queue.bounded<EncodedThreadFrames>(maximumSessionMessages))
  const protocolNegotiated = Deferred.makeUnsafe<ClientProtocolVersion>()
  const inbound = Effect.runSync(
    Queue.unbounded<{
      readonly message: ClientMessage
      readonly processed: Deferred.Deferred<void>
    }>(),
  )
  let outboundBytes = 0
  let acceptingOutput = true
  let negotiatedVersion: ClientProtocolVersion | undefined
  const enqueue = (socket: Socket, frames: ReadonlyArray<ServerFrame>) =>
    Effect.sync(() => {
      if (!acceptingOutput || frames.length === 0) return
      if (negotiatedVersion === undefined) return
      const encoded = encodeThreadFrames(frames, negotiatedVersion)
      if (outboundBytes + encoded.bytes > maximumThreadSocketBytes || !Queue.offerUnsafe(outbound, encoded)) {
        acceptingOutput = false
        socket.close(1013, "Thread output limit exceeded")
        return
      }
      outboundBytes += encoded.bytes
    })
  const write = (socket: Socket) =>
    Queue.take(outbound).pipe(
      Effect.tap((frames) =>
        Effect.sync(() => {
          outboundBytes -= frames.bytes
        }).pipe(Effect.andThen(sendEncodedThreadFrames(socket, frames))),
      ),
      Effect.forever,
    )
  const process = (socket: Socket) =>
    Effect.raceFirst(
      Queue.take(inbound).pipe(Effect.map((value) => ({ _tag: "Inbound" as const, value }))),
      Deferred.await(protocolNegotiated).pipe(
        Effect.andThen(connection.outbound),
        Effect.map((frames) => ({ _tag: "Outbound" as const, frames })),
        Effect.catch(() =>
          Effect.sync(() => socket.close(1011, "Thread replay failed")).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    ).pipe(
      Effect.flatMap((next) =>
        next._tag === "Inbound"
          ? Effect.sync(() =>
              runCommand(
                connection.receive(next.value.message).pipe(
                  Effect.flatMap((frames) => enqueue(socket, frames)),
                  Effect.ensuring(Deferred.succeed(next.value.processed, undefined)),
                ),
              ),
            ).pipe(Effect.andThen(Deferred.await(next.value.processed)))
          : enqueue(socket, next.frames),
      ),
      Effect.forever,
    )
  return ownedSession({
    kind: "thread",
    opened: (socket) => Effect.raceFirst(write(socket), process(socket)),
    receive: (socket, message) => {
      const body = Buffer.from(message).toString("utf8")
      const inspected = inspectClientProtocolVersion(body)
      if (!isSupportedClientProtocolVersion(inspected.protocolVersion))
        return Effect.sync(() => {
          socket.send(protocolMismatchFrame(inspected))
          socket.close(protocolMismatchCloseCode, protocolMismatchMessage)
        })
      return decodeThreadMessage(body).pipe(
        Effect.flatMap((decoded) =>
          Effect.suspend(() => {
            if (negotiatedVersion !== undefined && negotiatedVersion !== decoded.protocolVersion)
              return Effect.sync(() => socket.close(1003, "Thread protocol version changed"))
            negotiatedVersion = decoded.protocolVersion
            return Deferred.succeed(protocolNegotiated, negotiatedVersion).pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  const processed = yield* Deferred.make<void>()
                  yield* Queue.offer(inbound, { message: normalizeClientMessage(decoded), processed })
                  yield* Deferred.await(processed)
                }),
              ),
            )
          }),
        ),
        Effect.catch(() => Effect.sync(() => socket.close(1003, "invalid Thread protocol frame"))),
      )
    },
    disconnected: () => connection.detach,
    active: () => Effect.succeed(true),
    maximumQueuedBytes: maximumThreadSocketBytes,
  })
}

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
      const reverseMessages = yield* FiberSet.make<void, never>()
      const runReverseMessage = yield* FiberSet.runtime(reverseMessages)<never>()
      const threadCommands = yield* FiberSet.make<void, never>()
      const runThreadCommand = yield* FiberSet.runtime(threadCommands)<never>()
      const context = yield* Effect.context<never>()
      return yield* Effect.sync(() => {
        const api = Api.makeRikaApiHandler(input.dependencies)
        const sessions = new Set<Session>()
        const authoritySessions = new Set<Session>()
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
        const supplementalApi = Http.makeSupplementalApiRequestHandler(input.dependencies)
        const server = Bun.serve<Session>({
          hostname: input.config.production ? "0.0.0.0" : "127.0.0.1",
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
                    const current = threadSession(connection, runThreadCommand)
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
              const current = session(
                pathname === "/api/v1/executors" ? "executor" : "runner",
                gateway,
                runReverseMessage,
              )
              sessions.add(current)
              authoritySessions.add(current)
              if (bunServer.upgrade(request, { data: current })) return undefined
              sessions.delete(current)
              authoritySessions.delete(current)
              runSessionClose(current.drain())
              return new Response("WebSocket upgrade required", { status: 426 })
            }
            const publicRequest = canonicalPublicRequest({ request, baseUrl: input.config.baseUrl })
            if (Api.isRikaApiPath(pathname))
              return runRequest(
                bridgePromise(() => api.handler(publicRequest, undefined)).pipe(
                  Effect.map(Http.secureResponse(input.dependencies.production)),
                ),
              )
            return runRequest(bridgePromise(() => supplementalApi(publicRequest)))
          },
          websocket: {
            maxPayloadLength: maximumThreadSocketBytes,
            open: (socket) => {
              socket.data.attach(socket)
            },
            message: (socket, message) => socket.data.receive(socket, message),
            close: (socket, code) => {
              sessions.delete(socket.data)
              authoritySessions.delete(socket.data)
              runSessionClose(
                Effect.logInfo("hosted.websocket.closed").pipe(
                  Effect.annotateLogs({
                    "rika.websocket.kind": socket.data.kind,
                    "rika.websocket.code": code,
                  }),
                  Effect.andThen(socket.data.disconnected(socket)),
                ),
              )
            },
          },
        })
        return {
          api,
          server,
          sessions,
          authoritySessions,
          waitForRequests,
          sessionClosureScope,
          sessionClosures,
          runSessionClose,
          reverseMessages,
          threadCommands,
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
      reverseMessages,
      threadCommands,
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
          yield* FiberSet.awaitEmpty(reverseMessages)
          yield* FiberSet.awaitEmpty(threadCommands)
          yield* Effect.all([waitForRequests, bridgePromise(() => stopped)], {
            concurrency: "unbounded",
            discard: true,
          })
        }).pipe(Effect.timeoutOption("5 seconds"))
        if (graceful._tag === "None") {
          for (const current of draining) current.close()
          yield* FiberSet.clear(reverseMessages)
          yield* FiberSet.clear(threadCommands)
          yield* bridgePromise(() => server.stop(true))
        } else {
          yield* Scope.close(sessionClosureScope, Exit.void)
        }
        yield* bridgePromise(api.dispose)
      }),
  ).pipe(
    Effect.tap((resources) =>
      pollAuthority(resources.authoritySessions).pipe(Effect.forkScoped({ startImmediately: true })),
    ),
  )
