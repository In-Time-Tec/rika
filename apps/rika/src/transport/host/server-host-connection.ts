import * as ProductOperation from "@rika/product/product-operation"
import { Clock, Console, Deferred, Effect, Fiber, FiberSet, Queue, Ref, Schema, Scope, Semaphore } from "effect"
import type { Crypto as CryptoShape } from "effect/Crypto"
import * as ServerHandshake from "@rika/product/server-service-handshake"
import * as ServerService from "@rika/product/server-service"
import { executeInteractiveCommand } from "@rika/product/interactive-command"
import * as Socket from "effect/unstable/socket/Socket"
import { makeClientMessageFrameDecoder } from "../protocol/server-message-codec"
import { decodeClient, json, maxFrameBytes, parse } from "../protocol/server-protocol"
import { transportError } from "../protocol/server-message-codec"
import { handleOperation } from "./server-host-operation"
import { routeKey as makeRouteKey } from "./server-host-feed"
import type { InteractiveRouter } from "./server-host-feed"
import type { ServerRoute } from "./server-host-types"

type HostOptions = {
  readonly identity: string
  readonly token: string
  readonly outboundCapacity: number
}
type Lifecycle = Effect.Success<ReturnType<typeof ServerService.ServiceRuntime.makeLifecycle>>
type ConnectionContext = {
  readonly options: HostOptions
  readonly crypto: CryptoShape
  readonly baseConsole: Console.Console
  readonly hostScope: Scope.Scope
  readonly serviceNonce: string
  readonly graceFiber: Ref.Ref<Fiber.Fiber<void> | undefined>
  readonly lifecycle: Lifecycle
  readonly hostWork: FiberSet.FiberSet<void, never>
  readonly activeConnections: Ref.Ref<Map<string, Effect.Effect<void>>>
  readonly operationAdmission: Semaphore.Semaphore
  readonly drainingFailure: (requestId: string, operation: string) => string
  readonly scheduleGrace: (generation: number, delay?: number) => Effect.Effect<void>
  readonly abandonFiber: Ref.Ref<Fiber.Fiber<void> | undefined>
  readonly scheduleAbandonment: (
    generation: number,
    requireActiveWork?: boolean,
    sleepMilliseconds?: number,
  ) => Effect.Effect<void>
  readonly requestByInput: WeakMap<object, { readonly requestId: string; readonly routeKey: string }>
  readonly routes: Ref.Ref<Map<string, ServerRoute>>
  readonly interactive: InteractiveRouter
  readonly operationReady: Deferred.Deferred<import("@rika/product/product-operation-service").Interface>
  readonly hasActiveExecutionWork: Effect.Effect<boolean>
}

export const makeConnectionHandler = (context: ConnectionContext) => {
  const {
    options,
    crypto,
    baseConsole,
    hostScope,
    serviceNonce,
    graceFiber,
    lifecycle,
    hostWork,
    activeConnections,
    operationAdmission,
    drainingFailure,
    scheduleGrace,
    abandonFiber,
    scheduleAbandonment,
    requestByInput,
    routes,
    operationReady,
    hasActiveExecutionWork,
  } = context
  const activeConnectionsRef = activeConnections
  const abandonFiberRef = abandonFiber
  const graceFiberRef = graceFiber
  const routesRef = routes
  return Effect.fn("ServerTransport.connection")(function* (socket: Socket.Socket) {
    const rawWriter = yield* socket.writer
    const outbound = yield* Queue.bounded<string | Socket.CloseEvent>(options.outboundCapacity)
    const outboundMessages = yield* Semaphore.make(1)
    const closeWritten = yield* Deferred.make<void>()
    const writer = (frame: string | Socket.CloseEvent): Effect.Effect<void, ServerService.ServerServiceError> => {
      if (typeof frame === "string" && new TextEncoder().encode(frame).byteLength > maxFrameBytes)
        return Effect.fail(transportError("Server frame exceeds maximum size"))
      return Queue.offer(outbound, frame).pipe(Effect.asVoid)
    }
    yield* Effect.forkChild(
      Effect.gen(function* () {
        while (true) {
          const frame = yield* Queue.take(outbound)
          yield* rawWriter(frame)
          if (typeof frame !== "string") {
            yield* Deferred.succeed(closeWritten, undefined)
            return
          }
        }
      }),
    )
    const inbound = yield* Semaphore.make(1)
    const attached = yield* Ref.make(false)
    const decodeClientFrame = makeClientMessageFrameDecoder()
    const requests = yield* Ref.make(
      new Map<string, Fiber.Fiber<void, ProductOperation.OperationUnavailable | ServerService.ServerServiceError>>(),
    )
    const connectionId = yield* crypto.randomUUIDv4
    const routeKey = (requestId: string) => makeRouteKey(connectionId, requestId)
    const close = (code: number, reason?: string) => writer(new Socket.CloseEvent(code, reason))
    yield* Ref.update(activeConnectionsRef, (current) =>
      current.set(
        connectionId,
        Queue.offer(outbound, new Socket.CloseEvent(1001)).pipe(
          Effect.andThen(Deferred.await(closeWritten)),
          Effect.ignore,
        ),
      ),
    )
    yield* socket
      .runString((text) =>
        inbound.withPermits(1)(
          Effect.gen(function* () {
            if (new TextEncoder().encode(text).byteLength > maxFrameBytes) return yield* close(4400)
            const isAttached = yield* Ref.get(attached)
            const decoded = yield* Effect.result(
              Effect.try({
                try: () => (isAttached ? decodeClientFrame(text) : decodeClient(parse(text))),
                catch: () => transportError("Invalid server request"),
              }),
            )
            if (decoded._tag === "Failure") {
              return yield* close(4400)
            }
            const message = decoded.success
            if (message === undefined) return
            if (!isAttached) {
              if (!("family" in message)) return yield* close(4401)
              const result = ServerHandshake.HandshakeProtocol.validateHandshake(message, {
                identity: options.identity,
                token: options.token,
                buildIdentity: ServerHandshake.HandshakeProtocol.buildIdentity,
              })
              if (result._tag !== "Accepted") {
                const incompatible = result._tag === "ProtocolMismatch" || result._tag === "BuildMismatch"
                const reason = incompatible
                  ? `Incompatible Rika server PID ${process.pid}; the newly launched Rika replaces it`
                  : `Rika server PID ${process.pid} rejected this credential; close other Rika clients, stop PID ${process.pid}, then run rika again`
                yield* Effect.logWarning("server.connection.rejected").pipe(
                  Effect.annotateLogs({
                    "rika.server.connection.id": connectionId,
                    "rika.server.rejection.reason": result._tag,
                  }),
                )
                if (incompatible) {
                  const disposition =
                    message.connectRole === "launch"
                      ? yield* lifecycle.authorizeReplacement(hasActiveExecutionWork)
                      : ("restart" as const)
                  const replacementDelayed = disposition === "defer"
                  const response = {
                    _tag: "incompatible" as const,
                    disposition,
                    replacementGuard: ServerHandshake.HandshakeProtocol.replacementGuard,
                    family: "rika-server" as const,
                    identity: options.identity,
                    clientNonce: message.clientNonce,
                    serviceNonce,
                    connectionId,
                    protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
                    buildIdentity: ServerHandshake.HandshakeProtocol.buildIdentity,
                    serverPid: process.pid,
                  }
                  yield* writer(
                    json({
                      ...response,
                      serverProof: ServerHandshake.HandshakeProtocol.serverProof(options.token, message, response),
                    } satisfies ServerHandshake.HandshakeIncompatible),
                  )
                  if (replacementDelayed)
                    yield* Effect.logWarning("server.replacement.delayed").pipe(
                      Effect.annotateLogs("rika.server.rejection.reason", "active-execution-work"),
                    )
                  return yield* close(
                    4406,
                    replacementDelayed
                      ? `Rika server PID ${process.pid} owns active execution work; replacement is delayed until that work completes`
                      : reason,
                  )
                }
                return yield* close(4401, reason)
              }
              if (!(yield* lifecycle.tryAttach)) {
                yield* writer(
                  json({ _tag: "rejected", reason: "draining" } satisfies ServerHandshake.HandshakeRejected),
                )
                return yield* close(4409)
              }
              yield* Ref.set(attached, true)
              const existing = yield* Ref.get(graceFiberRef)
              if (existing !== undefined) yield* Fiber.interrupt(existing)
              yield* Ref.set(graceFiberRef, undefined)
              const pendingAbandonment = yield* Ref.get(abandonFiberRef)
              if (pendingAbandonment !== undefined) yield* Fiber.interrupt(pendingAbandonment)
              yield* Ref.set(abandonFiberRef, undefined)
              const response = {
                _tag: "accepted" as const,
                family: "rika-server" as const,
                identity: options.identity,
                clientNonce: message.clientNonce,
                serviceNonce,
                connectionId,
                protocolVersion: ServerHandshake.HandshakeProtocol.protocolVersion,
                buildIdentity: ServerHandshake.HandshakeProtocol.buildIdentity,
                serverPid: process.pid,
              }
              const acceptedProof = ServerHandshake.HandshakeProtocol.serverProof(options.token, message, response)
              yield* writer(
                json({
                  ...response,
                  serverProof: acceptedProof,
                } satisfies ServerHandshake.HandshakeAccepted),
              )
              yield* Effect.logInfo("server.connection.accepted").pipe(
                Effect.annotateLogs({
                  "rika.server.client.kind": message.clientKind,
                  "rika.server.connection.id": connectionId,
                }),
              )
              return
            }
            if (!("_tag" in message)) return
            if (message._tag === "ping") yield* writer(json({ _tag: "pong", id: message.id }))
            if (message._tag === "cancel") {
              const fiber = (yield* Ref.get(requests)).get(message.requestId)
              if (fiber !== undefined) yield* Fiber.interrupt(fiber)
            }
            if (message._tag === "interactive-end") {
              const active = (yield* Ref.get(routesRef))
                .get(routeKey(message.requestId))
                ?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration
              )
                return yield* close(4400)
              yield* Deferred.succeed(active.ended, undefined)
            }
            if (message._tag === "cancel-interactive-command") {
              const active = (yield* Ref.get(routesRef))
                .get(routeKey(message.requestId))
                ?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration
              )
                return yield* close(4400)
              const command = active.commands.get(message.commandSequence)
              if (command !== undefined) yield* Deferred.succeed(command, undefined)
            }
            if (message._tag === "interactive-feed-ack") {
              const active = (yield* Ref.get(routesRef))
                .get(routeKey(message.requestId))
                ?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration ||
                !(yield* active.acknowledge(message.throughSequence))
              )
                return yield* close(4400)
              if (message.throughSequence % 1_024 === 0)
                yield* Effect.logInfo("server.feed.ack_received").pipe(
                  Effect.annotateLogs("rika.server.feed.sequence", message.throughSequence),
                )
            }
            if (message._tag === "interactive-feed-replay") {
              const active = (yield* Ref.get(routesRef))
                .get(routeKey(message.requestId))
                ?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration
              )
                return yield* close(4400)
              yield* active.replay(message.afterSequence)
            }
            if (message._tag === "interactive-command") {
              const active = (yield* Ref.get(routesRef))
                .get(routeKey(message.requestId))
                ?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration ||
                !active.acceptCommand(message.commandSequence)
              )
                return yield* close(4400)
              const startedAt = yield* Clock.currentTimeMillis
              yield* Effect.logInfo("server.interactive_command.accepted").pipe(
                Effect.annotateLogs({
                  "rika.server.request.id": message.requestId,
                  "rika.server.session.id": message.sessionId,
                  "rika.server.command.sequence": message.commandSequence,
                  "rika.server.command.tag": message.command._tag,
                }),
              )
              const releaseReplacementWork = yield* lifecycle.reserveReplacementWork
              if (releaseReplacementWork === undefined) {
                yield* writer(
                  json({
                    _tag: "interactive-command-failed",
                    connectionId,
                    requestId: message.requestId,
                    sessionId: message.sessionId,
                    feedGeneration: message.feedGeneration,
                    commandSequence: message.commandSequence,
                    error: ProductOperation.OperationUnavailable.make({
                      operation: message.command._tag,
                      message: "Rika Server is draining",
                    }),
                  } satisfies ServerService.ServerMessage),
                )
                return
              }
              const cancelled = yield* Deferred.make<void>()
              const effect = Effect.gen(function* () {
                if (message.command._tag !== "Quit" || (yield* lifecycle.soleClient))
                  yield* executeInteractiveCommand(active.session, message.command)
                const completedAt = yield* Clock.currentTimeMillis
                yield* Effect.logInfo("server.interactive_command.completed").pipe(
                  Effect.annotateLogs({
                    "rika.server.request.id": message.requestId,
                    "rika.server.session.id": message.sessionId,
                    "rika.server.command.sequence": message.commandSequence,
                    "rika.server.command.tag": message.command._tag,
                    "rika.duration.ms": completedAt - startedAt,
                  }),
                )
                yield* writer(
                  json({
                    _tag: "interactive-command-completed",
                    connectionId,
                    requestId: message.requestId,
                    sessionId: message.sessionId,
                    feedGeneration: message.feedGeneration,
                    commandSequence: message.commandSequence,
                  } satisfies ServerService.ServerMessage),
                )
              }).pipe(
                Effect.asVoid,
                Effect.catch((failure) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((failedAt) =>
                      Effect.logError("server.interactive_command.failed").pipe(
                        Effect.annotateLogs({
                          "rika.server.request.id": message.requestId,
                          "rika.server.session.id": message.sessionId,
                          "rika.server.command.sequence": message.commandSequence,
                          "rika.server.command.tag": message.command._tag,
                          "rika.failure.kind": String(failure),
                          "rika.duration.ms": failedAt - startedAt,
                        }),
                      ),
                    ),
                    Effect.andThen(
                      writer(
                        json({
                          _tag: "interactive-command-failed",
                          connectionId,
                          requestId: message.requestId,
                          sessionId: message.sessionId,
                          feedGeneration: message.feedGeneration,
                          commandSequence: message.commandSequence,
                          error: Schema.is(ProductOperation.OperationUnavailable)(failure)
                            ? failure
                            : ProductOperation.OperationUnavailable.make({
                                operation: message.command._tag,
                                message: String(failure),
                              }),
                        } satisfies ServerService.ServerMessage),
                      ),
                    ),
                  ),
                ),
                Effect.ensuring(releaseReplacementWork),
                Effect.ensuring(
                  Effect.sync(() => {
                    active.commandReleases.delete(message.commandSequence)
                  }),
                ),
              )
              active.commands.set(message.commandSequence, cancelled)
              active.commandReleases.set(message.commandSequence, releaseReplacementWork)
              if (message.command._tag === "Cancel" || message.command._tag === "Quit")
                yield* Effect.forkIn(
                  Effect.raceFirst(Deferred.await(cancelled), effect).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        if (active.commands.get(message.commandSequence) === cancelled)
                          active.commands.delete(message.commandSequence)
                      }),
                    ),
                  ),
                  hostScope,
                )
              else
                yield* Queue.offer(active.commandQueue, {
                  sequence: message.commandSequence,
                  cancelled,
                  effect,
                }).pipe(Effect.onError(() => releaseReplacementWork))
            }
            if (message._tag === "operation")
              yield* handleOperation({
                message,
                requests,
                close,
                writer,
                connectionId,
                routeKey,
                requestByInput,
                outboundMessages,
                routesRef,
                lifecycle,
                hostWork,
                options,
                baseConsole,
                rawWriter: (frame) => rawWriter(frame).pipe(Effect.ignore),
                operationReady,
                operationAdmission,
                drainingFailure,
              })
          }),
        ),
      )
      .pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Ref.update(activeConnectionsRef, (current) => (current.delete(connectionId), current))
            if (!(yield* Ref.get(attached))) return
            const activeRequests = yield* Ref.get(requests)
            const activeRoutes = yield* Ref.get(routesRef)
            for (const requestId of activeRequests.keys()) {
              const route = activeRoutes.get(routeKey(requestId))
              if (route === undefined) continue
              for (const session of route.sessions.values()) {
                for (const command of session.commands.values()) yield* Deferred.succeed(command, undefined)
                yield* Deferred.succeed(session.ended, undefined)
              }
            }
            for (const fiber of activeRequests.values()) yield* Fiber.interrupt(fiber)
            yield* Ref.update(routesRef, (current) => {
              for (const requestId of activeRequests.keys()) current.delete(routeKey(requestId))
              return current
            })
            const generation = yield* lifecycle.detach
            yield* Effect.logInfo("server.connection.closed").pipe(
              Effect.annotateLogs("rika.server.connection.id", connectionId),
            )
            if (generation === undefined) return
            yield* scheduleGrace(generation)
            yield* scheduleAbandonment(generation)
            yield* Effect.logInfo("server.idle-generation.started").pipe(
              Effect.annotateLogs({
                "rika.server.connection.id": connectionId,
                "rika.server.generation": generation,
              }),
            )
          }),
        ),
      )
  })
}
