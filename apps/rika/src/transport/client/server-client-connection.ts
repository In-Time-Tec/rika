import * as ProductOperation from "@rika/product/product-operation"
import * as InteractiveSession from "@rika/product/interactive-session"
import * as InteractiveEvent from "@rika/product/interactive-event"
import type { InteractiveCommand } from "@rika/product/interactive-command"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as ServerHandshake from "@rika/product/server-service-handshake"
import * as ServerFeed from "@rika/product/server-interactive-feed"
import * as ServerService from "@rika/product/server-service"
import * as ThreadView from "@rika/product/thread-view"
import * as Thread from "@rika/product/thread-record"
import { Context, Crypto, Deferred, Effect, Exit, Layer, Queue, Ref, Schema, Scope, Semaphore } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { makeClientMessageWriter, makePhysicalFeed, traceInteractiveEvent } from "./server-client-feed"
import type { ClientRequest, PhysicalFeed } from "./server-client-feed"
import { makeInteractiveSession } from "./server-client-session"
import { serverSocketFailure } from "./server-client-reconnect"
import { clientMessageFrames, makeServerMessageFrameDecoder, transportError } from "@rika/server/server-message-codec"
import { defaultOutboundCapacity, json, maxFrameBytes } from "@rika/server/server-protocol"
import { makeClientHandshakePair, verifyServerHandshake } from "@rika/server/server-protocol-handshake"

const gapEvent = (event: InteractiveEvent.InteractiveEvent): InteractiveEvent.InteractiveEvent | undefined => {
  if (event._tag === "ResyncRequired") return event
  if (event._tag === "ThreadViewSnapshot")
    return ThreadView.ResyncRequired.make({
      threadId: event.snapshot.thread.id,
      expectedRevision: event.snapshot.revision,
      receivedBaseRevision: event.snapshot.revision,
      currentRevision: event.snapshot.revision,
    })
  if (event._tag === "ThreadViewPatch")
    return ThreadView.ResyncRequired.make({
      threadId: event.patch.threadId,
      expectedRevision: event.patch.revision,
      receivedBaseRevision: event.patch.baseRevision,
      currentRevision: event.patch.baseRevision,
    })
  if ("threadId" in event && event.threadId !== undefined)
    return ThreadView.ResyncRequired.make({
      threadId: Thread.ThreadId.make(String(event.threadId)),
      expectedRevision: 0,
      receivedBaseRevision: 0,
      currentRevision: 0,
    })
  return undefined
}

export const connect = Effect.fn("ServerTransport.connect")(function* (options: {
  readonly url: string
  readonly identity: string
  readonly token: string
  readonly clientKind: ServerHandshake.Handshake["clientKind"]
  readonly connectRole: ServerHandshake.ConnectRole
  readonly role: ServerService.Connection["role"]
}) {
  const crypto = yield* Crypto.Crypto
  const connectionScope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(connectionScope, Exit.void))
  const webSocketContext = yield* Scope.provide(Layer.build(BunSocket.layerWebSocketConstructor), connectionScope)
  const webSocketConstructor = Context.get(webSocketContext, Socket.WebSocketConstructor)
  const socket = yield* Scope.provide(
    Socket.makeWebSocket(options.url).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)),
    connectionScope,
  )
  const rawWriter = yield* Scope.provide(socket.writer, connectionScope)
  const outbound = yield* Queue.bounded<string | Socket.CloseEvent>(defaultOutboundCapacity)
  const closing = yield* Deferred.make<void>()
  const closed = yield* Deferred.make<void>()
  const writer = (frame: string | Socket.CloseEvent) =>
    Deferred.isDone(closing).pipe(
      Effect.flatMap((isClosing) => {
        if (isClosing) return Effect.fail(transportError("Server connection is closing"))
        if (typeof frame === "string" && new TextEncoder().encode(frame).byteLength > maxFrameBytes)
          return Effect.fail(transportError("Server frame exceeds maximum size"))
        return Queue.offer(outbound, frame).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(transportError("Server outbound queue is overloaded")),
          }),
          Effect.asVoid,
        )
      }),
    )
  yield* Effect.forkIn(Effect.forever(Queue.take(outbound).pipe(Effect.flatMap(rawWriter))), connectionScope)
  const accepted = yield* Deferred.make<ServerHandshake.HandshakeAccepted>()
  let acceptedConnectionId: string | undefined
  const clientNonce = yield* crypto.randomUUIDv4
  const connectionFailure = yield* Deferred.make<never, ServerService.ServerServiceError>()
  const write = (frame: string | Socket.CloseEvent) =>
    writer(frame).pipe(Effect.tapError((error) => Deferred.fail(connectionFailure, error)))
  const writeClientMessage = makeClientMessageWriter(write)
  const pongs = yield* Ref.make(new Map<string, Deferred.Deferred<void, ServerService.ServerServiceError>>())
  const inbound = yield* Semaphore.make(1)
  const receivedDeltas = new Set<string>()
  const requests = yield* Ref.make(new Map<string, ClientRequest>())
  const { handshake, signedHandshake } = yield* makeClientHandshakePair({
    identity: options.identity,
    token: options.token,
    clientNonce,
    clientKind: options.clientKind,
    connectRole: options.connectRole,
  })
  const decodeFrame = makeServerMessageFrameDecoder()
  yield* socket
    .runString(
      (frame) =>
        inbound.withPermits(1)(
          (new TextEncoder().encode(frame).byteLength > maxFrameBytes
            ? Effect.fail(transportError("Server frame exceeds maximum size"))
            : Effect.try({
                try: () => decodeFrame(frame),
                catch: () => transportError("Invalid server response"),
              })
          ).pipe(
            Effect.flatMap((message) => {
              if (message === undefined) return Effect.void
              if (message._tag === "accepted" || message._tag === "incompatible") {
                if (message.identity !== options.identity || message.clientNonce !== clientNonce)
                  return Effect.fail(transportError("Foreign server listener", "foreign-listener"))
                return verifyServerHandshake(options.token, signedHandshake, message).pipe(
                  Effect.flatMap((authenticated) => {
                    if (!authenticated)
                      return Effect.fail(transportError("Foreign server listener", "foreign-listener"))
                    if (message._tag === "incompatible") {
                      const validDisposition =
                        options.connectRole === "launch"
                          ? message.disposition === "supersede" || message.disposition === "defer"
                          : message.disposition === "restart"
                      if (!validDisposition)
                        return Effect.fail(
                          transportError("Server returned an invalid upgrade disposition", "foreign-listener"),
                        )
                      if (!ServerHandshake.HandshakeProtocol.isValidIncompatibility(options.connectRole, message))
                        return Effect.fail(
                          transportError(
                            "Server returned an incompatible response for a compatible handshake",
                            "foreign-listener",
                          ),
                        )
                      if (message.disposition === "defer")
                        return Effect.fail(
                          ServerService.ServerServiceError.make({
                            reason: "replacement-delayed",
                            message: `Rika server replacement is delayed because server${message.serverPid === undefined ? "" : ` PID ${message.serverPid}`} owns active execution work. Try again after that work completes`,
                            ...(message.serverPid === undefined ? {} : { serverPid: message.serverPid }),
                          }),
                        )
                      return Effect.fail(
                        ServerService.ServerServiceError.make({
                          reason: "incompatible-server",
                          message: `An incompatible Rika server${message.serverPid === undefined ? "" : ` (PID ${message.serverPid})`} is still running at ${options.url}; close other Rika clients, then run rika again`,
                          ...(message.serverPid === undefined ? {} : { serverPid: message.serverPid }),
                        }),
                      )
                    }
                    if (message.protocolVersion !== ServerHandshake.HandshakeProtocol.protocolVersion)
                      return Effect.fail(
                        transportError(
                          `An incompatible Rika server${message.serverPid === undefined ? "" : ` (PID ${message.serverPid})`} is still running at ${options.url}; close other Rika clients, then run rika again`,
                          "incompatible-server",
                        ),
                      )
                    if (
                      options.connectRole === "launch" &&
                      message.buildIdentity !== ServerHandshake.HandshakeProtocol.buildIdentity
                    )
                      return Effect.fail(transportError("Server accepted an incompatible launch", "foreign-listener"))
                    return Effect.sync(() => (acceptedConnectionId = message.connectionId)).pipe(
                      Effect.andThen(Deferred.succeed(accepted, message)),
                      Effect.asVoid,
                    )
                  }),
                )
              }
              if (message._tag === "rejected")
                return Deferred.fail(connectionFailure, transportError("Rika Server is draining", "server-draining"))

              if (message._tag === "pong")
                return Effect.gen(function* () {
                  const pending = (yield* Ref.get(pongs)).get(message.id)
                  if (pending !== undefined) yield* Deferred.succeed(pending, undefined)
                })
              return Effect.gen(function* () {
                const request = (yield* Ref.get(requests)).get(message.requestId)
                if (request === undefined) return
                if (message._tag === "output")
                  yield* (message.channel === "stdout"
                    ? request.stdout?.(message.text)
                    : request.stderr?.(message.text)) ?? Effect.void
                if (message._tag === "interactive-feed-event") {
                  const feed = request.feed
                  if (
                    acceptedConnectionId !== message.connectionId ||
                    feed === undefined ||
                    feed.sessionId !== message.sessionId ||
                    feed.generation !== message.feedGeneration
                  )
                    return yield* transportError("Server sent an event for a stale interactive feed")
                  if (message.sequence < feed.expectedSequence) return
                  if (message.sequence > feed.expectedSequence) {
                    const event = gapEvent(message.event)
                    if (event === undefined)
                      return yield* transportError(
                        `Server interactive feed sequence gap: expected ${feed.expectedSequence}, received ${message.sequence}`,
                      )
                    feed.expectedSequence = message.sequence + 1
                    yield* Queue.offer(feed.frames, { ...message, event })
                    return
                  }
                  feed.expectedSequence = message.sequence + 1
                  yield* traceInteractiveEvent("client.feed.event_received", receivedDeltas, message.event)
                  yield* Queue.offer(feed.frames, message)
                }
                if (message._tag === "interactive-command-completed" || message._tag === "interactive-command-failed") {
                  const feed = request.feed
                  if (
                    acceptedConnectionId !== message.connectionId ||
                    feed === undefined ||
                    feed.sessionId !== message.sessionId ||
                    feed.generation !== message.feedGeneration
                  )
                    return yield* transportError("Server sent a result for a stale interactive feed")
                  const command = request.commands.get(message.commandSequence)
                  if (command !== undefined)
                    yield* message._tag === "interactive-command-completed"
                      ? Deferred.succeed(command, undefined)
                      : Deferred.fail(command, message.error)
                }
                if (
                  message._tag === "interactive-started" &&
                  request.input._tag === "Interactive" &&
                  request.interactive !== undefined
                ) {
                  if (
                    acceptedConnectionId !== message.connectionId ||
                    request.feed !== undefined ||
                    message.feedCapacity < 1
                  )
                    return yield* transportError("Server started an invalid interactive feed")
                  const feed: PhysicalFeed = yield* makePhysicalFeed(
                    message.sessionId,
                    message.feedGeneration,
                    message.feedCapacity,
                  )
                  request.feed = feed
                  let nextCommandSequence = 1
                  const commandWriteLock = yield* Semaphore.make(1)
                  const unavailable = (text: string) =>
                    ProductOperation.OperationUnavailable.make({ operation: "ServerConnection", message: text })
                  const invoke = Effect.fn("ServerTransport.interactiveCommand")(function* (
                    command: InteractiveCommand,
                  ) {
                    const done = yield* Deferred.make<void, ProductOperation.OperationUnavailable>()
                    const commandSequence = yield* commandWriteLock.withPermits(1)(
                      Effect.gen(function* () {
                        const frames = yield* Effect.try({
                          try: () =>
                            clientMessageFrames(`${message.requestId}:${nextCommandSequence}`, {
                              _tag: "interactive-command",
                              connectionId: message.connectionId,
                              requestId: message.requestId,
                              sessionId: message.sessionId,
                              feedGeneration: message.feedGeneration,
                              commandSequence: nextCommandSequence,
                              command,
                            }),
                          catch: (error) =>
                            Schema.is(ServerService.ServerServiceError)(error) && error.reason === "message-too-large"
                              ? ProductOperation.OperationUnavailable.make({
                                  operation: command._tag,
                                  message:
                                    "The prompt and attachments exceed the 16 MiB server message limit; remove or shrink image attachments",
                                })
                              : unavailable(String(error)),
                        })
                        const sequence = nextCommandSequence
                        nextCommandSequence += 1
                        request.commands.set(sequence, done)
                        yield* Effect.forEach(frames, write, { discard: true }).pipe(
                          Effect.mapError((error) => unavailable(error.message)),
                        )
                        return sequence
                      }),
                    )
                    yield* Effect.raceFirst(
                      Deferred.await(done),
                      Deferred.await(closed).pipe(
                        Effect.andThen(
                          Effect.fail(unavailable("Server connection closed before the command outcome was known")),
                        ),
                      ),
                    ).pipe(
                      Effect.ensuring(
                        Deferred.isDone(done).pipe(
                          Effect.flatMap((completed) =>
                            completed
                              ? Effect.void
                              : sendBestEffort(
                                  json({
                                    _tag: "cancel-interactive-command",
                                    connectionId: message.connectionId,
                                    requestId: message.requestId,
                                    sessionId: message.sessionId,
                                    feedGeneration: message.feedGeneration,
                                    commandSequence,
                                  } satisfies ServerService.ClientMessage),
                                ),
                          ),
                          Effect.andThen(Effect.sync(() => request.commands.delete(commandSequence))),
                        ),
                      ),
                    )
                  })
                  const session = makeInteractiveSession({
                    feed,
                    closed,
                    invoke,
                    write,
                    unavailable,
                    traceEvent: (event, seen) => traceInteractiveEvent("client.feed.event_dispatched", seen, event),
                  })
                  if (request.interactiveStarted !== undefined)
                    yield* Deferred.succeed(request.interactiveStarted, {
                      sessionId: message.sessionId,
                      feedGeneration: message.feedGeneration,
                      session,
                    })
                }
                if (message._tag === "operation-completed" || message._tag === "operation-failed") {
                  if (message._tag === "operation-completed") yield* Deferred.succeed(request.done, undefined)
                  else yield* Deferred.fail(request.done, message.error)
                  for (const command of request.commands.values())
                    yield* Deferred.fail(
                      command,
                      message._tag === "operation-failed"
                        ? message.error
                        : ProductOperation.OperationUnavailable.make({
                            operation: "ServerConnection",
                            message: "Server operation completed before the command outcome was known",
                          }),
                    )
                  if (request.feed !== undefined) yield* Queue.shutdown(request.feed.frames)
                }
              })
            }),
          ),
        ),
      { onOpen: write(handshake).pipe(Effect.ignore) },
    )
    .pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const failure = Schema.is(ServerService.ServerServiceError)(cause)
            ? cause
            : serverSocketFailure(cause, yield* Deferred.isDone(accepted))
          yield* Deferred.fail(connectionFailure, failure)
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          const failure = transportError("Server connection closed", "server-absent")
          const operationFailure = ProductOperation.OperationUnavailable.make({
            operation: "ServerConnection",
            message: failure.message,
          })
          for (const waiter of (yield* Ref.get(pongs)).values()) yield* Deferred.fail(waiter, failure)
          for (const request of (yield* Ref.get(requests)).values()) {
            yield* Deferred.fail(request.done, operationFailure)
            if (request.interactiveStarted !== undefined) yield* Deferred.interrupt(request.interactiveStarted)
            for (const command of request.commands.values()) yield* Deferred.fail(command, operationFailure)
            if (request.feed !== undefined) yield* Queue.shutdown(request.feed.frames)
          }
          yield* Deferred.succeed(closed, undefined)
        }),
      ),
      Effect.forkIn(connectionScope),
    )
  const disconnected = Effect.raceFirst(
    Deferred.await(connectionFailure),
    Deferred.await(closed).pipe(
      Effect.andThen(Effect.fail(transportError("Server connection closed", "server-absent"))),
    ),
  )
  const whileConnected = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.raceFirst(effect, disconnected)
  const sendBestEffort = (frame: string | Socket.CloseEvent) =>
    writer(frame).pipe(Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.void }), Effect.ignore)
  const response = yield* Effect.raceFirst(Deferred.await(accepted), disconnected).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(transportError("Server handshake timed out", "transport-failed")),
    }),
  )
  yield* Effect.logInfo("server.connection.ready").pipe(
    Effect.annotateLogs({
      "rika.server.client.kind": options.clientKind,
      "rika.server.connection.id": response.connectionId,
      "rika.server.connection.role": options.role,
    }),
  )
  const ping = Effect.acquireUseRelease(
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4
      const completed = yield* Deferred.make<void, ServerService.ServerServiceError>()
      yield* Ref.update(pongs, (current) => current.set(id, completed))
      yield* write(json({ _tag: "ping", id } satisfies ServerService.ClientMessage))
      return { id, completed }
    }),
    ({ completed }) =>
      Deferred.await(completed).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(transportError("Server ping timed out")),
        }),
      ),
    ({ id }) => Ref.update(pongs, (current) => (current.delete(id), current)),
  ).pipe(
    Effect.mapError((cause) =>
      Schema.is(ServerService.ServerServiceError)(cause)
        ? cause
        : transportError(`Server ping failed: ${String(cause)}`),
    ),
  )
  return {
    role: options.role,
    endpoint: options.url,
    connectionId: response.connectionId,
    ping,
    run: (input, runOptions) =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          const requestId = yield* crypto.randomUUIDv4
          const done = yield* Deferred.make<void, ProductOperation.OperationUnavailable>()
          const interactiveStarted =
            runOptions?.interactive === undefined
              ? undefined
              : yield* Deferred.make<{
                  readonly sessionId: string
                  readonly feedGeneration: string
                  readonly session: InteractiveSession.InteractiveSession
                }>()
          yield* Ref.update(requests, (current) =>
            current.set(requestId, {
              done,
              ...(runOptions?.stdout === undefined ? {} : { stdout: runOptions.stdout }),
              ...(runOptions?.stderr === undefined ? {} : { stderr: runOptions.stderr }),
              ...(runOptions?.interactive === undefined ? {} : { interactive: runOptions.interactive }),
              ...(interactiveStarted === undefined ? {} : { interactiveStarted }),
              input,
              commands: new Map(),
            }),
          )
          yield* writeClientMessage(requestId, { _tag: "operation", requestId, input })
          return { requestId, done, interactiveStarted }
        }),
        ({ requestId, done, interactiveStarted }) =>
          interactiveStarted === undefined || runOptions?.interactive === undefined
            ? whileConnected(Deferred.await(done))
            : Effect.raceFirst(
                whileConnected(Deferred.await(interactiveStarted)).pipe(
                  Effect.map((started) => ({ _tag: "Started" as const, started })),
                ),
                whileConnected(Deferred.await(done)).pipe(Effect.as({ _tag: "Completed" as const })),
              ).pipe(
                Effect.flatMap((state) =>
                  state._tag === "Completed"
                    ? Effect.void
                    : Effect.raceFirst(
                        whileConnected(
                          runOptions.interactive!(input as ServerFeed.InteractiveInput, state.started.session),
                        ).pipe(
                          Effect.exit,
                          Effect.map((outcome) => ({ _tag: "Callback" as const, outcome })),
                        ),
                        whileConnected(Deferred.await(done)).pipe(
                          Effect.exit,
                          Effect.map((outcome) => ({ _tag: "Operation" as const, outcome })),
                        ),
                      ).pipe(
                        Effect.flatMap((completed) =>
                          completed._tag === "Operation"
                            ? completed.outcome
                            : sendBestEffort(
                                json({
                                  _tag: "interactive-end",
                                  connectionId: response.connectionId,
                                  requestId,
                                  sessionId: state.started.sessionId,
                                  feedGeneration: state.started.feedGeneration,
                                } satisfies ServerService.ClientMessage),
                              ).pipe(Effect.andThen(completed.outcome)),
                        ),
                      ),
                ),
                Effect.andThen(whileConnected(Deferred.await(done))),
              ),
        ({ requestId }) =>
          sendBestEffort(json({ _tag: "cancel", requestId } satisfies ServerService.ClientMessage)).pipe(
            Effect.andThen(Ref.update(requests, (current) => (current.delete(requestId), current))),
          ),
      ).pipe(
        Effect.mapError((error) =>
          Schema.is(ProductOperation.OperationUnavailable)(error) ? error : transportError(String(error)),
        ),
      ),
    closed: Deferred.await(closed),
    close: Deferred.isDone(closing).pipe(
      Effect.flatMap((alreadyClosing) =>
        alreadyClosing
          ? Deferred.await(closed)
          : Deferred.succeed(closing, undefined).pipe(
              Effect.andThen(rawWriter(new Socket.CloseEvent(1000)).pipe(Effect.ignore)),
              Effect.andThen(Deferred.await(closed)),
            ),
      ),
      Effect.timeoutOrElse({ duration: "500 millis", orElse: () => Effect.void }),
      Effect.ensuring(Scope.close(connectionScope, Exit.void)),
    ),
  } satisfies ServerService.Connection
})
