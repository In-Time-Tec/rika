import { Deferred, Effect, Exit, FiberSet, Function, Queue, Schema, Scope } from "effect"
import type { IdentityConfig } from "@rika/identity"
import {
  ClientMessage,
  type ClientProtocolVersion,
  inspectClientProtocolVersion,
  isSupportedClientProtocolVersion,
  protocolMismatchCloseCode,
  protocolMismatchFrame,
  protocolMismatchMessage,
  ServerFrame,
} from "@rika/product/client-protocol"
import type { Socket } from "../executor/gateway"
import * as Api from "../api"
import { threadWebSocketAudience, type HostedThreadConnection } from "../hosted/thread/protocol"
import * as Http from "./http"
import type { HttpDependencies } from "./http"
import { pollAuthority, type Session, sessionTransport } from "./session"
import { browserReviewConnection, browserThreadWebSocketPath } from "./browser-review"

export { pollAuthority } from "./session"
export { browserThreadWebSocketPath } from "./browser-review"

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

const decodeThreadMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClientMessage))
const encodeThreadFrame = Schema.encodeSync(Schema.fromJsonString(ServerFrame))
const maximumThreadSocketBytes = 32 * 1024 * 1024

interface EncodedThreadFrames {
  readonly values: ReadonlyArray<string>
  readonly bytes: number
}

const encodeThreadFrames = (frames: ReadonlyArray<ServerFrame>): EncodedThreadFrames => {
  const values = frames.map((frame) => encodeThreadFrame(frame))
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
  const outbound = Effect.runSync(Queue.bounded<EncodedThreadFrames>(sessionTransport.maximumMessages))
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
  const validate = (socket: Socket) =>
    (connection.validate ?? Effect.succeed(true)).pipe(
      Effect.map((valid) => {
        if (!valid) {
          acceptingOutput = false
          socket.close(1008, "Browser review access expired")
        }
        return valid && acceptingOutput
      }),
    )
  const enqueue = (socket: Socket, frames: ReadonlyArray<ServerFrame>) =>
    Effect.sync(() => {
      if (!acceptingOutput || frames.length === 0) return
      if (negotiatedVersion === undefined) return
      const encoded = encodeThreadFrames(frames)
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
        }).pipe(
          Effect.andThen(validate(socket)),
          Effect.flatMap((valid) => (valid ? sendEncodedThreadFrames(socket, frames) : Effect.void)),
        ),
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
          validate(socket).pipe(
            Effect.tap((valid) =>
              valid ? Effect.sync(() => socket.close(1011, "Thread replay failed")) : Effect.void,
            ),
            Effect.andThen(Effect.never),
          ),
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
  return sessionTransport.owned({
    kind: "thread",
    opened: (socket) =>
      Effect.raceFirst(
        Effect.raceFirst(write(socket), process(socket)),
        connection.validate === undefined
          ? Effect.never
          : Effect.sleep("1 second").pipe(Effect.andThen(validate(socket)), Effect.forever),
      ),
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
                  yield* Queue.offer(inbound, { message: decoded, processed })
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
    active: () => connection.validate ?? Effect.succeed(true),
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
            if (pathname === browserThreadWebSocketPath) {
              return runRequest(
                browserReviewConnection({ ...input, request }).pipe(
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
                  Effect.catch(Effect.succeed),
                ),
              )
            }
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
              const current = sessionTransport.gateway(
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
