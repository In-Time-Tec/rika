import * as ProductOperation from "@rika/product/product-operation"
import { Clock, Deferred, Effect, Fiber, Queue, Ref, Schema, Semaphore } from "effect"
import * as ResidentHandshake from "@rika/product/resident-service-handshake"
import * as ResidentService from "@rika/product/resident-service"
import { executeInteractiveCommand } from "@rika/product/interactive-command"
import * as Socket from "effect/unstable/socket/Socket"
import { makeClientMessageFrameDecoder } from "../protocol/resident-message-codec"
import { decodeClient, json, maxFrameBytes, parse } from "../protocol/resident-protocol"
import { transportError } from "../protocol/resident-message-codec"
import { handleOperation } from "./resident-host-operation"
import { routeKey as makeRouteKey } from "./resident-host-feed"

type ConnectionContext = {
  readonly options: any
  readonly crypto: any
  readonly baseConsole: any
  readonly hostScope: any
  readonly serviceNonce: any
  readonly graceFiber: any
  readonly lifecycle: any
  readonly hostWork: any
  readonly activeConnections: any
  readonly operationAdmission: any
  readonly drainingFailure: any
  readonly scheduleGrace: any
  readonly abandonFiber: any
  readonly scheduleAbandonment: any
  readonly requestByInput: any
  readonly routes: any
  readonly interactive: any
  readonly server: any
  readonly operationReady: any
  readonly hasActiveExecutionWork: any
}

export const makeConnectionHandler = (context: ConnectionContext): any => {
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
  const activeConnectionsRef = activeConnections as Ref.Ref<any>
  const abandonFiberRef = abandonFiber as Ref.Ref<any>
  const graceFiberRef = graceFiber as Ref.Ref<any>
  const routesRef = routes as Ref.Ref<any>
  return Effect.fn("ResidentTransport.connection")(function* (socket: Socket.Socket) {
    const rawWriter = yield* socket.writer
    const outbound = yield* Queue.bounded<string | Socket.CloseEvent>(options.outboundCapacity)
    const outboundMessages = yield* Semaphore.make(1)
    const closeWritten = yield* Deferred.make<void>()
    const writer = (frame: string | Socket.CloseEvent): Effect.Effect<void, ResidentService.ResidentServiceError> => {
      if (typeof frame === "string" && new TextEncoder().encode(frame).byteLength > maxFrameBytes)
        return Effect.fail(transportError("Resident frame exceeds maximum size"))
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
    const requests = yield* Ref.make(new Map<string, Fiber.Fiber<void, unknown>>())
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
                catch: () => transportError("Invalid resident request"),
              }),
            )
            if (decoded._tag === "Failure") {
              if (!isAttached) {
                const legacy = yield* Effect.result(
                  Effect.try({
                    try: () => parse(text),
                    catch: () => transportError("Invalid legacy resident request"),
                  }).pipe(
                    Effect.flatMap(Schema.decodeUnknownEffect(ResidentHandshake.HandshakeProtocol.HandshakeV3)),
                    Effect.mapError(() => transportError("Invalid legacy resident request")),
                  ),
                )
                if (
                  legacy._tag === "Success" &&
                  ResidentHandshake.HandshakeProtocol.validateHandshakeV3(legacy.success, {
                    identity: options.identity,
                    token: options.token,
                  })
                )
                  return yield* close(4406)
              }
              return yield* close(4400)
            }
            const message = decoded.success
            if (message === undefined) return
            if (!isAttached) {
              if (!("family" in message)) return yield* close(4401)
              const result = ResidentHandshake.HandshakeProtocol.validateHandshake(message, {
                identity: options.identity,
                token: options.token,
                buildIdentity: ResidentHandshake.HandshakeProtocol.buildIdentity,
              })
              if (result._tag !== "Accepted") {
                const incompatible = result._tag === "ProtocolMismatch" || result._tag === "BuildMismatch"
                const reason = incompatible
                  ? `Incompatible Rika resident PID ${process.pid}; the newly launched Rika replaces it`
                  : `Rika resident PID ${process.pid} rejected this credential; close other Rika clients, stop PID ${process.pid}, then run rika again`
                yield* Effect.logWarning("resident.connection.rejected").pipe(
                  Effect.annotateLogs({
                    "rika.resident.connection.id": connectionId,
                    "rika.resident.rejection.reason": result._tag,
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
                    replacementGuard: ResidentHandshake.HandshakeProtocol.replacementGuard,
                    family: "rika-resident" as const,
                    identity: options.identity,
                    clientNonce: message.clientNonce,
                    serviceNonce,
                    connectionId,
                    protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
                    buildIdentity: ResidentHandshake.HandshakeProtocol.buildIdentity,
                    residentPid: process.pid,
                  }
                  yield* writer(
                    json({
                      ...response,
                      serverProof: ResidentHandshake.HandshakeProtocol.serverProof(options.token, message, response),
                    } satisfies ResidentHandshake.HandshakeIncompatible),
                  )
                  if (replacementDelayed)
                    yield* Effect.logWarning("resident.replacement.delayed").pipe(
                      Effect.annotateLogs("rika.resident.rejection.reason", "active-execution-work"),
                    )
                  return yield* close(
                    4406,
                    replacementDelayed
                      ? `Rika resident PID ${process.pid} owns active execution work; replacement is delayed until that work completes`
                      : reason,
                  )
                }
                return yield* close(4401, reason)
              }
              if (!(yield* lifecycle.tryAttach)) {
                yield* writer(
                  json({ _tag: "rejected", reason: "draining" } satisfies ResidentHandshake.HandshakeRejected),
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
                family: "rika-resident" as const,
                identity: options.identity,
                clientNonce: message.clientNonce,
                serviceNonce,
                connectionId,
                protocolVersion: ResidentHandshake.HandshakeProtocol.protocolVersion,
                buildIdentity: ResidentHandshake.HandshakeProtocol.buildIdentity,
                residentPid: process.pid,
              }
              const acceptedProof = ResidentHandshake.HandshakeProtocol.serverProof(options.token, message, response)
              yield* writer(
                json({
                  ...response,
                  serverProof: acceptedProof,
                } satisfies ResidentHandshake.HandshakeAccepted),
              )
              yield* Effect.logInfo("resident.connection.accepted").pipe(
                Effect.annotateLogs({
                  "rika.resident.client.kind": message.clientKind,
                  "rika.resident.connection.id": connectionId,
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
                yield* Effect.logInfo("resident.feed.ack_received").pipe(
                  Effect.annotateLogs("rika.resident.feed.sequence", message.throughSequence),
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
              yield* Effect.logInfo("resident.interactive_command.accepted").pipe(
                Effect.annotateLogs({
                  "rika.resident.request.id": message.requestId,
                  "rika.resident.session.id": message.sessionId,
                  "rika.resident.command.sequence": message.commandSequence,
                  "rika.resident.command.tag": message.command._tag,
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
                      message: "Resident service is draining",
                    }),
                  } satisfies ResidentService.ServerMessage),
                )
                return
              }
              const cancelled = yield* Deferred.make<void>()
              const effect = Effect.gen(function* () {
                if (message.command._tag !== "Quit" || (yield* lifecycle.soleClient))
                  yield* executeInteractiveCommand(active.session, message.command)
                const completedAt = yield* Clock.currentTimeMillis
                yield* Effect.logInfo("resident.interactive_command.completed").pipe(
                  Effect.annotateLogs({
                    "rika.resident.request.id": message.requestId,
                    "rika.resident.session.id": message.sessionId,
                    "rika.resident.command.sequence": message.commandSequence,
                    "rika.resident.command.tag": message.command._tag,
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
                  } satisfies ResidentService.ServerMessage),
                )
              }).pipe(
                Effect.asVoid,
                Effect.catch((failure) =>
                  Clock.currentTimeMillis.pipe(
                    Effect.flatMap((failedAt) =>
                      Effect.logError("resident.interactive_command.failed").pipe(
                        Effect.annotateLogs({
                          "rika.resident.request.id": message.requestId,
                          "rika.resident.session.id": message.sessionId,
                          "rika.resident.command.sequence": message.commandSequence,
                          "rika.resident.command.tag": message.command._tag,
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
                        } satisfies ResidentService.ServerMessage),
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
                rawWriter,
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
            const activeRequests = (yield* Ref.get(requests)) as Map<string, Fiber.Fiber<void, unknown>>
            const activeRoutes = (yield* Ref.get(routesRef)) as Map<string, any>
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
            yield* Effect.logInfo("resident.connection.closed").pipe(
              Effect.annotateLogs("rika.resident.connection.id", connectionId),
            )
            if (generation === undefined) return
            yield* scheduleGrace(generation)
            yield* scheduleAbandonment(generation)
            yield* Effect.logInfo("resident.idle-generation.started").pipe(
              Effect.annotateLogs({
                "rika.resident.connection.id": connectionId,
                "rika.resident.generation": generation,
              }),
            )
          }) as any,
        ),
      )
  })
}
