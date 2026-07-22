import * as BunSocket from "@effect/platform-bun/BunSocket"
import * as Operation from "@rika/app/operation-contract"
import * as ResidentService from "@rika/app/resident-service"
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Function,
  Layer,
  Path,
  Queue,
  Ref,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Socket from "effect/unstable/socket/Socket"
import { readOrCreateToken, resolve } from "./resident-endpoint"
import * as ResidentProcessStartup from "./resident-process-startup"
import { claimStartup } from "./resident-startup"
import {
  clientMessageFrames,
  defaultOutboundCapacity,
  failureKind,
  json,
  makeServerMessageFrameDecoder,
  maxFrameBytes,
  transportError,
} from "./resident-wire"

const ignoreInteractiveEvent = (_event: Operation.InteractiveEvent) => {}

const tracedEventTypes = new Set([
  "model.reasoning.delta",
  "model.output.delta",
  "model.toolcall.delta",
  "tool.call.requested",
  "tool.result.received",
])

const traceInteractiveEvent = (name: string, seenDeltas: Set<string>, event: Operation.InteractiveEvent) => {
  if (event._tag !== "TranscriptPatched" || !tracedEventTypes.has(event.event.type)) return Effect.void
  const delta = event.event.type.endsWith(".delta")
  const key = `${event.turnId}:${event.event.type}`
  if (delta && seenDeltas.has(key)) return Effect.void
  if (delta) seenDeltas.add(key)
  return Effect.logInfo(name).pipe(
    Effect.annotateLogs({
      "rika.event.cursor": event.event.cursor,
      "rika.event.type": event.event.type,
      "rika.thread.id": String(event.threadId),
      "rika.turn.id": String(event.turnId),
    }),
  )
}

const mapResidentSocketFailure = (cause: unknown, accepted: boolean): ResidentService.ResidentServiceError => {
  if (Socket.SocketError.is(cause) && cause.reason._tag === "SocketCloseError") {
    if (cause.reason.code === 4409 || cause.reason.code === 1001)
      return transportError("Resident service is draining", "resident-draining")
    if (cause.reason.code === 4406)
      return transportError(
        cause.reason.closeReason ||
          "A listener reported an unsigned resident incompatibility; stop it, then run rika again",
        "foreign-listener",
      )
    if (cause.reason.code === 4401)
      return transportError(
        cause.reason.closeReason ??
          "A Rika resident with different credentials is still running; close other Rika clients, then run rika again",
        "foreign-listener",
      )
  }
  return transportError(String(cause), accepted ? "transport-failed" : "resident-absent")
}
export const residentSocketFailure: {
  (accepted: boolean): (cause: unknown) => ResidentService.ResidentServiceError
  (cause: unknown, accepted: boolean): ResidentService.ResidentServiceError
} = Function.dual(2, mapResidentSocketFailure)
const reconnectFailureLimit = 8
const reconnectStableMilliseconds = 30_000
const reconnectSchedule = Schedule.exponential("25 millis").pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(1)))),
)
type InteractiveFeedFrame = Extract<
  ResidentService.ServerMessage,
  { readonly _tag: "interactive-feed-event" | "interactive-feed-resync" }
>
type PhysicalFeed = {
  readonly sessionId: string
  readonly generation: string
  readonly frames: Queue.Queue<InteractiveFeedFrame>
  expectedSequence: number
  replayRequestedAfter: number | undefined
  consumerAttached: boolean
}
const isDisconnectedOperation = (error: unknown) =>
  Schema.is(Operation.OperationUnavailable)(error) && error.operation === "ResidentConnection"
const isReconnectableTransport = (error: unknown) =>
  Schema.is(ResidentService.ResidentServiceError)(error) &&
  (error.reason === "resident-absent" || error.reason === "resident-draining" || error.reason === "transport-failed")
const connect = Effect.fn("ResidentTransport.connect")(function* (options: {
  readonly url: string
  readonly identity: string
  readonly token: string
  readonly clientKind: ResidentService.Handshake["clientKind"]
  readonly connectRole: ResidentService.ConnectRole
  readonly role: ResidentService.Connection["role"]
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
        if (isClosing) return Effect.fail(transportError("Resident connection is closing"))
        if (typeof frame === "string" && new TextEncoder().encode(frame).byteLength > maxFrameBytes)
          return Effect.fail(transportError("Resident frame exceeds maximum size"))
        return Queue.offer(outbound, frame).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(transportError("Resident outbound queue is overloaded")),
          }),
          Effect.asVoid,
        )
      }),
    )
  yield* Effect.forkIn(Effect.forever(Queue.take(outbound).pipe(Effect.flatMap(rawWriter))), connectionScope)
  const accepted = yield* Deferred.make<ResidentService.HandshakeAccepted>()
  let acceptedConnectionId: string | undefined
  const clientNonce = yield* crypto.randomUUIDv4
  const connectionFailure = yield* Deferred.make<never, ResidentService.ResidentServiceError>()
  const write = (frame: string | Socket.CloseEvent) =>
    writer(frame).pipe(Effect.tapError((error) => Deferred.fail(connectionFailure, error)))
  const writeClientMessage = (messageId: string, message: ResidentService.ClientMessage) =>
    Effect.try({
      try: () => clientMessageFrames(messageId, message),
      catch: (error) =>
        Schema.is(ResidentService.ResidentServiceError)(error) ? error : transportError(String(error)),
    }).pipe(Effect.flatMap(Effect.forEach((frame) => write(frame), { discard: true })))
  const pongs = yield* Ref.make(new Map<string, Deferred.Deferred<void, ResidentService.ResidentServiceError>>())
  const inbound = yield* Semaphore.make(1)
  const receivedDeltas = new Set<string>()
  const dispatchedDeltas = new Set<string>()
  const requests = yield* Ref.make(
    new Map<
      string,
      {
        readonly done: Deferred.Deferred<void, Operation.OperationUnavailable>
        readonly stdout?: (text: string) => Effect.Effect<void>
        readonly stderr?: (text: string) => Effect.Effect<void>
        readonly interactive?: (
          input: ResidentService.InteractiveInput,
          session: Operation.InteractiveSession,
        ) => Effect.Effect<void, Operation.OperationUnavailable>
        readonly interactiveStarted?: Deferred.Deferred<{
          readonly sessionId: string
          readonly feedGeneration: string
          readonly session: Operation.InteractiveSession
        }>
        readonly input: Operation.Input
        readonly commands: Map<number, Deferred.Deferred<void, Operation.OperationUnavailable>>
        feed?: PhysicalFeed
      }
    >(),
  )
  const signedHandshake = {
    identity: options.identity,
    clientNonce,
    clientKind: options.clientKind,
    connectRole: options.connectRole,
    protocolVersion: ResidentService.protocolVersion,
    buildIdentity: ResidentService.buildIdentity,
  }
  const handshake = json({
    family: "rika-resident",
    ...signedHandshake,
    clientProof: ResidentService.clientProof(options.token, signedHandshake),
  } satisfies ResidentService.Handshake)
  const decodeFrame = makeServerMessageFrameDecoder()
  yield* socket
    .runString(
      (frame) =>
        inbound.withPermits(1)(
          (new TextEncoder().encode(frame).byteLength > maxFrameBytes
            ? Effect.fail(transportError("Resident frame exceeds maximum size"))
            : Effect.try({
                try: () => decodeFrame(frame),
                catch: () => transportError("Invalid resident response"),
              })
          ).pipe(
            Effect.flatMap((message) => {
              if (message === undefined) return Effect.void
              if (message._tag === "accepted" || message._tag === "incompatible") {
                if (message.identity !== options.identity || message.clientNonce !== clientNonce)
                  return Effect.fail(transportError("Foreign resident listener", "foreign-listener"))
                if (!ResidentService.verifyServerProof(options.token, signedHandshake, message))
                  return Effect.fail(transportError("Foreign resident listener", "foreign-listener"))
                if (message._tag === "incompatible") {
                  const expectedDisposition = options.connectRole === "launch" ? "supersede" : "restart"
                  if (message.disposition !== expectedDisposition)
                    return Effect.fail(
                      transportError("Resident returned an invalid upgrade disposition", "foreign-listener"),
                    )
                  if (!ResidentService.isValidIncompatibility(options.connectRole, message))
                    return Effect.fail(
                      transportError(
                        "Resident returned an incompatible response for a compatible handshake",
                        "foreign-listener",
                      ),
                    )
                  return Effect.fail(
                    ResidentService.ResidentServiceError.make({
                      reason: "incompatible-resident",
                      message: `An incompatible Rika resident${message.residentPid === undefined ? "" : ` (PID ${message.residentPid})`} is still running at ${options.url}; close other Rika clients, then run rika again`,
                      ...(message.residentPid === undefined ? {} : { residentPid: message.residentPid }),
                    }),
                  )
                }
                if (message.protocolVersion !== ResidentService.protocolVersion)
                  return Effect.fail(
                    transportError(
                      `An incompatible Rika resident${message.residentPid === undefined ? "" : ` (PID ${message.residentPid})`} is still running at ${options.url}; close other Rika clients, then run rika again`,
                      "incompatible-resident",
                    ),
                  )
                if (options.connectRole === "launch" && message.buildIdentity !== ResidentService.buildIdentity)
                  return Effect.fail(transportError("Resident accepted an incompatible launch", "foreign-listener"))
                return Effect.sync(() => (acceptedConnectionId = message.connectionId)).pipe(
                  Effect.andThen(Deferred.succeed(accepted, message)),
                )
              }
              if (message._tag === "rejected")
                return Deferred.fail(
                  connectionFailure,
                  transportError("Resident service is draining", "resident-draining"),
                )
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
                if (message._tag === "interactive-feed-event" || message._tag === "interactive-feed-resync") {
                  const feed = request.feed
                  if (
                    acceptedConnectionId !== message.connectionId ||
                    feed === undefined ||
                    feed.sessionId !== message.sessionId ||
                    feed.generation !== message.feedGeneration
                  )
                    return yield* transportError("Resident sent an event for a stale interactive feed")
                  if (message.sequence < feed.expectedSequence) return
                  if (message._tag === "interactive-feed-event" && message.sequence > feed.expectedSequence) {
                    const afterSequence = feed.expectedSequence - 1
                    if (feed.replayRequestedAfter !== afterSequence) {
                      feed.replayRequestedAfter = afterSequence
                      yield* write(
                        json({
                          _tag: "interactive-feed-replay",
                          connectionId: message.connectionId,
                          requestId: message.requestId,
                          sessionId: message.sessionId,
                          feedGeneration: message.feedGeneration,
                          afterSequence,
                        } satisfies ResidentService.ClientMessage),
                      )
                    }
                    return
                  }
                  feed.expectedSequence = message.sequence + 1
                  feed.replayRequestedAfter = undefined
                  if (message._tag === "interactive-feed-resync")
                    yield* Effect.logInfo("resident.feed.barrier_received")
                  if (message._tag === "interactive-feed-event")
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
                    return yield* transportError("Resident sent a result for a stale interactive feed")
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
                    return yield* transportError("Resident started an invalid interactive feed")
                  const feed: PhysicalFeed = {
                    sessionId: message.sessionId,
                    generation: message.feedGeneration,
                    frames: yield* Queue.bounded<InteractiveFeedFrame>(message.feedCapacity),
                    expectedSequence: 1,
                    replayRequestedAfter: undefined,
                    consumerAttached: false,
                  }
                  request.feed = feed
                  let nextCommandSequence = 1
                  const commandWriteLock = yield* Semaphore.make(1)
                  const unavailable = (text: string) =>
                    Operation.OperationUnavailable.make({ operation: "ResidentConnection", message: text })
                  const invoke = Effect.fn("ResidentTransport.interactiveCommand")(function* (
                    command: Operation.InteractiveCommand,
                  ) {
                    const done = yield* Deferred.make<void, Operation.OperationUnavailable>()
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
                            Schema.is(ResidentService.ResidentServiceError)(error) &&
                            error.reason === "message-too-large"
                              ? Operation.OperationUnavailable.make({
                                  operation: command._tag,
                                  message:
                                    "The prompt and attachments exceed the 16 MiB resident message limit; remove or shrink image attachments",
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
                          Effect.fail(unavailable("Resident connection closed before the command outcome was known")),
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
                                  } satisfies ResidentService.ClientMessage),
                                ),
                          ),
                          Effect.andThen(Effect.sync(() => request.commands.delete(commandSequence))),
                        ),
                      ),
                    )
                  })
                  const session: Operation.InteractiveSession = {
                    events: (dispatch) =>
                      Effect.suspend(() => {
                        if (feed.consumerAttached)
                          return Effect.fail(
                            Operation.OperationUnavailable.make({
                              operation: "InteractiveSession.events",
                              message: "Interactive session already has an event consumer",
                            }),
                          )
                        feed.consumerAttached = true
                        const consume = Effect.gen(function* () {
                          while (true) {
                            const frames = yield* Queue.takeAll(feed.frames)
                            const batchTails = new Map<string, (typeof frames)[number]>()
                            for (const queued of frames) {
                              yield* Effect.uninterruptible(
                                Effect.sync(() => {
                                  if (queued._tag === "interactive-feed-event") dispatch(queued.event)
                                  else for (const event of queued.events) dispatch(event)
                                }).pipe(
                                  Effect.andThen(
                                    queued._tag === "interactive-feed-event"
                                      ? traceInteractiveEvent(
                                          "client.feed.event_dispatched",
                                          dispatchedDeltas,
                                          queued.event,
                                        )
                                      : Effect.void,
                                  ),
                                ),
                              )
                              batchTails.set(
                                `${queued.connectionId} ${queued.requestId} ${queued.sessionId} ${queued.feedGeneration}`,
                                queued,
                              )
                            }
                            for (const queued of batchTails.values()) {
                              yield* Effect.uninterruptible(
                                write(
                                  json({
                                    _tag: "interactive-feed-ack",
                                    connectionId: queued.connectionId,
                                    requestId: queued.requestId,
                                    sessionId: queued.sessionId,
                                    feedGeneration: queued.feedGeneration,
                                    throughSequence: queued.sequence,
                                  } satisfies ResidentService.ClientMessage),
                                ).pipe(Effect.mapError((error) => unavailable(error.message))),
                              )
                              if (queued.sequence % 1_024 === 0)
                                yield* Effect.logInfo("resident.feed.ack_consumed").pipe(
                                  Effect.annotateLogs("rika.resident.feed.sequence", queued.sequence),
                                )
                            }
                          }
                        }).pipe(
                          Effect.ensuring(
                            Effect.sync(() => {
                              feed.consumerAttached = false
                            }),
                          ),
                        )
                        return Effect.raceFirst(
                          consume,
                          Deferred.await(closed).pipe(
                            Effect.andThen(Effect.fail(unavailable("Resident connection closed"))),
                          ),
                        )
                      }),
                    submit: (prompt, mode, promptParts, modelTuning) =>
                      invoke({
                        _tag: "Submit",
                        prompt,
                        ...(mode === undefined ? {} : { mode }),
                        ...(promptParts === undefined ? {} : { promptParts }),
                        ...(modelTuning === undefined ? {} : { modelTuning }),
                      }),
                    shell: (command, incognito) => invoke({ _tag: "Shell", command, incognito }),
                    editQueued: (turnId, prompt) => invoke({ _tag: "EditQueued", turnId, prompt }),
                    dequeue: (turnId) => invoke({ _tag: "Dequeue", turnId }),
                    steerQueued: (turnId, text) => invoke({ _tag: "SteerQueued", turnId, text }),
                    steer: (text) => invoke({ _tag: "Steer", text }),
                    interruptAndSend: (prompt) => invoke({ _tag: "InterruptAndSend", prompt }),
                    cancel: invoke({ _tag: "Cancel" }),
                    newThread: invoke({ _tag: "NewThread" }),
                    resolvePermission: (waitId, kind, decision) =>
                      invoke({ _tag: "ResolvePermission", waitId, kind, decision }),
                    selectThread: (threadId, selectionEpoch) =>
                      invoke({ _tag: "SelectThread", threadId, selectionEpoch }),
                    readQueue: (threadId) => invoke({ _tag: "ReadQueue", threadId }),
                    loadOlder: invoke({ _tag: "LoadOlder" }),
                    previewThread: (threadId) => invoke({ _tag: "PreviewThread", threadId }),
                    reopenThread: (selectionEpoch) => invoke({ _tag: "ReopenThread", selectionEpoch }),
                    replay: (turnId, afterCursor) =>
                      invoke({
                        _tag: "Replay",
                        turnId,
                        ...(afterCursor === undefined ? {} : { afterCursor }),
                      }),
                  }
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
                        : Operation.OperationUnavailable.make({
                            operation: "ResidentConnection",
                            message: "Resident operation completed before the command outcome was known",
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
          const failure = Schema.is(ResidentService.ResidentServiceError)(cause)
            ? cause
            : residentSocketFailure(cause, yield* Deferred.isDone(accepted))
          yield* Deferred.fail(connectionFailure, failure)
        }),
      ),
      Effect.ensuring(
        Effect.gen(function* () {
          const failure = transportError("Resident connection closed", "resident-absent")
          const operationFailure = Operation.OperationUnavailable.make({
            operation: "ResidentConnection",
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
      Effect.andThen(Effect.fail(transportError("Resident connection closed", "resident-absent"))),
    ),
  )
  const whileConnected = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.raceFirst(effect, disconnected)
  const sendBestEffort = (frame: string | Socket.CloseEvent) =>
    writer(frame).pipe(Effect.timeoutOrElse({ duration: "250 millis", orElse: () => Effect.void }), Effect.ignore)
  const response = yield* Effect.raceFirst(Deferred.await(accepted), disconnected).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(transportError("Resident handshake timed out", "transport-failed")),
    }),
  )
  yield* Effect.logInfo("resident.connection.ready").pipe(
    Effect.annotateLogs({
      "rika.resident.client.kind": options.clientKind,
      "rika.resident.connection.id": response.connectionId,
      "rika.resident.connection.role": options.role,
    }),
  )
  const ping = Effect.acquireUseRelease(
    Effect.gen(function* () {
      const id = yield* crypto.randomUUIDv4
      const completed = yield* Deferred.make<void, ResidentService.ResidentServiceError>()
      yield* Ref.update(pongs, (current) => current.set(id, completed))
      yield* write(json({ _tag: "ping", id } satisfies ResidentService.ClientMessage))
      return { id, completed }
    }),
    ({ completed }) =>
      Deferred.await(completed).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(transportError("Resident ping timed out")),
        }),
      ),
    ({ id }) => Ref.update(pongs, (current) => (current.delete(id), current)),
  ).pipe(
    Effect.mapError((cause) =>
      Schema.is(ResidentService.ResidentServiceError)(cause)
        ? cause
        : transportError(`Resident ping failed: ${String(cause)}`),
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
          const done = yield* Deferred.make<void, Operation.OperationUnavailable>()
          const interactiveStarted =
            runOptions?.interactive === undefined
              ? undefined
              : yield* Deferred.make<{
                  readonly sessionId: string
                  readonly feedGeneration: string
                  readonly session: Operation.InteractiveSession
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
                          runOptions.interactive!(input as ResidentService.InteractiveInput, state.started.session),
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
                                } satisfies ResidentService.ClientMessage),
                              ).pipe(Effect.andThen(completed.outcome)),
                        ),
                      ),
                ),
                Effect.andThen(whileConnected(Deferred.await(done))),
              ),
        ({ requestId }) =>
          sendBestEffort(json({ _tag: "cancel", requestId } satisfies ResidentService.ClientMessage)).pipe(
            Effect.andThen(Ref.update(requests, (current) => (current.delete(requestId), current))),
          ),
      ).pipe(
        Effect.mapError((error) =>
          Schema.is(Operation.OperationUnavailable)(error) ? error : transportError(String(error)),
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
  } satisfies ResidentService.Connection
})

export const make = Effect.fn("ResidentTransport.make")(() =>
  Effect.succeed(
    ResidentService.Service.of({
      getOrCreate: (input) =>
        Effect.gen(function* () {
          const endpoint = yield* resolve(input.profile, input.dataRoot)
          const token = yield* readOrCreateToken(endpoint.tokenPath)
          const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const crypto = yield* Crypto.Crypto
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const connectionScope = yield* Scope.make()
          yield* Effect.addFinalizer((exit) => Scope.close(connectionScope, exit))
          const attach = (connectRole: ResidentService.ConnectRole) =>
            Effect.gen(function* () {
              const attemptScope = yield* Scope.fork(connectionScope)
              const result = yield* Effect.exit(
                connect({ ...endpoint, ...input, token, connectRole, role: "attached" }).pipe(
                  Scope.provide(attemptScope),
                ),
              )
              if (result._tag === "Failure") {
                yield* Scope.close(attemptScope, result)
                return yield* Effect.failCause(result.cause)
              }
              return result.value
            }).pipe(
              Effect.mapError((error) =>
                Schema.is(ResidentService.ResidentServiceError)(error)
                  ? error
                  : transportError(`Resident connection attempt failed: ${String(error)}`),
              ),
            )
          yield* Effect.logInfo("resident.connection.acquiring").pipe(
            Effect.annotateLogs("rika.resident.client.kind", input.clientKind),
          )
          const acquire = Effect.fn("ResidentTransport.acquireConnection")(function* (policy: "launch" | "reattach") {
            const yieldToIncompatible = (failure: ResidentService.ResidentServiceError) =>
              ResidentService.ResidentRestartRequired.make({ message: failure.message })
            const startedAt = yield* Clock.currentTimeMillis
            const deadline = startedAt + 30_000
            const first = yield* Effect.result(attach(policy))
            if (first._tag === "Success") return first.success
            if (policy === "reattach" && first.failure.reason === "incompatible-resident")
              return yield* yieldToIncompatible(first.failure)
            if (
              first.failure.reason !== "resident-absent" &&
              first.failure.reason !== "resident-draining" &&
              first.failure.reason !== "incompatible-resident"
            )
              return yield* first.failure
            if (input.startHost === undefined) return yield* first.failure
            if (input.startHost !== undefined) {
              let attempt = 0
              let lastFailure = first.failure
              while (true) {
                const connected = yield* Effect.result(attach(policy))
                if (connected._tag === "Success") {
                  yield* Effect.logInfo("resident.startup.ready").pipe(
                    Effect.annotateLogs("rika.duration.ms", (yield* Clock.currentTimeMillis) - startedAt),
                  )
                  return connected.success
                }
                lastFailure = connected.failure
                if (policy === "reattach" && lastFailure.reason === "incompatible-resident")
                  return yield* yieldToIncompatible(lastFailure)
                if (
                  lastFailure.reason !== "resident-absent" &&
                  lastFailure.reason !== "resident-draining" &&
                  lastFailure.reason !== "incompatible-resident"
                )
                  return yield* lastFailure
                if (lastFailure.reason === "resident-absent" || lastFailure.reason === "incompatible-resident") {
                  const claim = yield* claimStartup(endpoint.startupPath, endpoint.identity, deadline)
                  if (claim._tag === "Owner") {
                    const existing = yield* Effect.result(attach(policy))
                    if (existing._tag === "Success") {
                      yield* claim.release
                      yield* Effect.logInfo("resident.startup.ready").pipe(
                        Effect.annotateLogs("rika.duration.ms", (yield* Clock.currentTimeMillis) - startedAt),
                      )
                      return existing.success
                    }
                    lastFailure = existing.failure
                    if (policy === "reattach" && lastFailure.reason === "incompatible-resident") {
                      yield* claim.release
                      return yield* yieldToIncompatible(lastFailure)
                    }
                    if (lastFailure.reason === "resident-absent" || lastFailure.reason === "incompatible-resident") {
                      if (yield* ResidentProcessStartup.listenerIsLive(endpoint.port)) {
                        if (lastFailure.reason !== "incompatible-resident" || lastFailure.residentPid === undefined) {
                          yield* claim.release
                          return yield* transportError(
                            `A process is listening on Rika resident port ${endpoint.port}, but it could not be authenticated. Stop that process, then run rika again`,
                            "foreign-listener",
                          )
                        }
                        const listeners = yield* ResidentProcessStartup.listenerProcessIds(endpoint.port, [
                          lastFailure.residentPid,
                        ])
                        if (listeners.length !== 1) {
                          yield* claim.release
                          return yield* transportError(
                            `The stale Rika resident on port ${endpoint.port} was authenticated, but its PID could not be verified. Stop it, then run rika again`,
                            "foreign-listener",
                          )
                        }
                        yield* Effect.logWarning("resident.startup.superseding").pipe(
                          Effect.annotateLogs({
                            "rika.resident.previous.pid": listeners[0]!,
                            "rika.resident.port": endpoint.port,
                          }),
                        )
                        const superseded = yield* Effect.result(
                          ResidentProcessStartup.supersede(listeners[0]!, endpoint.port),
                        )
                        if (superseded._tag === "Failure") {
                          yield* claim.release
                          return yield* superseded.failure
                        }
                      }
                      const spawned = yield* Effect.result(input.startHost())
                      if (spawned._tag === "Failure") {
                        yield* claim.release
                        return yield* spawned.failure
                      }
                      const adopted = yield* Effect.result(claim.adopt(spawned.success.pid))
                      if (adopted._tag === "Failure") {
                        yield* spawned.success.abort
                        yield* claim.release
                        return yield* adopted.failure
                      }
                      const started = yield* Effect.result(spawned.success.startup)
                      if (started._tag === "Failure") {
                        yield* spawned.success.abort
                        yield* claim.release
                        return yield* started.failure
                      }
                      const attached = yield* Effect.result(attach(policy))
                      if (attached._tag === "Failure") {
                        yield* spawned.success.abort
                        yield* claim.release
                        lastFailure = attached.failure
                        yield* Effect.logWarning("resident.startup.attach_retry").pipe(
                          Effect.annotateLogs({
                            "rika.failure.kind": attached.failure._tag,
                            "rika.failure.reason": attached.failure.reason,
                          }),
                        )
                      } else {
                        const detached = yield* Effect.result(spawned.success.detach)
                        if (detached._tag === "Failure") {
                          yield* spawned.success.abort
                          yield* claim.release
                          return yield* detached.failure
                        }
                        yield* claim.release
                        yield* Effect.logInfo("resident.startup.ready").pipe(
                          Effect.annotateLogs("rika.duration.ms", (yield* Clock.currentTimeMillis) - startedAt),
                        )
                        return attached.success
                      }
                    } else {
                      yield* claim.release
                      if (lastFailure.reason !== "resident-draining") return yield* lastFailure
                    }
                  }
                }
                const now = yield* Clock.currentTimeMillis
                if (now >= deadline)
                  return yield* transportError(
                    `Resident did not become ready within 30 seconds: ${lastFailure.message}`,
                    "transport-failed",
                  )
                const ceiling = Math.min(250, 10 * 2 ** Math.min(attempt, 5))
                const jitter = (process.pid * 17 + attempt * 31) % Math.max(1, ceiling)
                attempt += 1
                yield* Effect.sleep(Math.min(deadline - now, ceiling + jitter))
              }
            }
            return yield* first.failure
          })
          const acquireReady = (policy: "launch" | "reattach") =>
            acquire(policy).pipe(
              Effect.timeoutOrElse({
                duration: "30 seconds",
                orElse: () =>
                  Effect.fail(
                    transportError("Resident acquisition exceeded its 30-second deadline", "transport-failed"),
                  ),
              }),
              Scope.provide(connectionScope),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.mapError((error) =>
                Schema.is(ResidentService.ResidentServiceError)(error) ||
                Schema.is(ResidentService.ResidentRestartRequired)(error)
                  ? error
                  : transportError(String(error)),
              ),
              Effect.tapError((error) =>
                Effect.logWarning("resident.connection.failed").pipe(
                  Effect.annotateLogs({
                    "rika.failure.kind": error._tag,
                    "rika.failure.reason": Schema.is(ResidentService.ResidentServiceError)(error)
                      ? error.reason
                      : "restart-required",
                    "rika.resident.client.kind": input.clientKind,
                  }),
                ),
              ),
            )
          const initial = yield* acquireReady(input.allowSupersede === false ? "reattach" : "launch")
          const logicalClosed = yield* Deferred.make<void>()
          const supervise = Effect.fn("ResidentTransport.superviseInteractive")(function* (
            operationInput: ResidentService.InteractiveInput,
            interactive: NonNullable<NonNullable<Parameters<ResidentService.Connection["run"]>[1]>["interactive"]>,
          ) {
            const firstSession = yield* Deferred.make<void>()
            const initialChange = yield* Deferred.make<void>()
            const sessions = yield* Ref.make<{
              readonly session: Operation.InteractiveSession | undefined
              readonly changed: Deferred.Deferred<void>
            }>({ session: undefined, changed: initialChange })
            const selected = yield* Ref.make<
              { readonly _tag: "thread"; readonly threadId: string } | { readonly _tag: "latest" } | undefined
            >(undefined)
            const wireEpoch = yield* Ref.make(0)
            let eventDispatch = ignoreInteractiveEvent
            let feedAttached = false
            const nextWireEpoch = (requested?: number) =>
              Ref.modify(wireEpoch, (current) => {
                const next = Math.max(current + 1, requested ?? current + 1)
                return [next, next]
              })
            const awaitSession: Effect.Effect<Operation.InteractiveSession> = Effect.suspend(() =>
              Ref.get(sessions).pipe(
                Effect.flatMap((state) =>
                  state.session === undefined
                    ? Deferred.await(state.changed).pipe(Effect.andThen(awaitSession))
                    : Effect.succeed(state.session),
                ),
              ),
            )
            const invalidate = (session: Operation.InteractiveSession) =>
              Effect.gen(function* () {
                const next = yield* Deferred.make<void>()
                const changed = yield* Ref.modify(sessions, (state) =>
                  state.session === session
                    ? [state.changed, { session: undefined, changed: next }]
                    : [undefined, state],
                )
                if (changed !== undefined) yield* Deferred.succeed(changed, undefined)
              })
            const report = (event: Operation.InteractiveEvent) => eventDispatch(event)
            const retryRead = (
              invoke: (session: Operation.InteractiveSession) => Effect.Effect<void, Operation.OperationUnavailable>,
            ): Effect.Effect<void> =>
              Effect.suspend(() =>
                awaitSession.pipe(
                  Effect.flatMap((session) =>
                    invoke(session).pipe(
                      Effect.catchCause((cause) => {
                        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                        if (isDisconnectedOperation(Cause.squash(cause)))
                          return invalidate(session).pipe(Effect.andThen(retryRead(invoke)))
                        return Effect.sync(() =>
                          report({
                            _tag: "ExecutionFailed",
                            selectionEpoch: 0,
                            message: String(Cause.squash(cause)),
                          }),
                        )
                      }),
                    ),
                  ),
                ),
              )
            const mutation = (
              invoke: (session: Operation.InteractiveSession) => Effect.Effect<void, Operation.OperationUnavailable>,
            ) =>
              awaitSession.pipe(
                Effect.flatMap((session) =>
                  invoke(session).pipe(
                    Effect.catchCause((cause) => {
                      if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
                      if (isDisconnectedOperation(Cause.squash(cause)))
                        return invalidate(session).pipe(
                          Effect.andThen(
                            Effect.sync(() =>
                              report({
                                _tag: "ExecutionFailed",
                                selectionEpoch: 0,
                                message:
                                  "Resident transport disconnected; the action outcome is unknown and was not retried",
                              }),
                            ),
                          ),
                        )
                      return Effect.sync(() =>
                        report({
                          _tag: "ExecutionFailed",
                          selectionEpoch: 0,
                          message: String(Cause.squash(cause)),
                        }),
                      )
                    }),
                  ),
                ),
              )
            const stable: Operation.InteractiveSession = {
              events: (dispatch) =>
                Effect.suspend(() => {
                  if (feedAttached)
                    return Effect.fail(
                      Operation.OperationUnavailable.make({
                        operation: "InteractiveSession.events",
                        message: "Interactive session already has an event consumer",
                      }),
                    )
                  feedAttached = true
                  eventDispatch = dispatch
                  return retryRead((session) => session.events(dispatch)).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        feedAttached = false
                        eventDispatch = ignoreInteractiveEvent
                      }),
                    ),
                  )
                }),
              submit: (prompt, mode, parts, tuning) =>
                mutation((session) => session.submit(prompt, mode, parts, tuning)),
              shell: (command, incognito) => mutation((session) => session.shell(command, incognito)),
              editQueued: (turnId, prompt) => mutation((session) => session.editQueued(turnId, prompt)),
              dequeue: (turnId) => mutation((session) => session.dequeue(turnId)),
              steerQueued: (turnId, text) => mutation((session) => session.steerQueued(turnId, text)),
              steer: (text) => mutation((session) => session.steer(text)),
              interruptAndSend: (prompt) => mutation((session) => session.interruptAndSend(prompt)),
              cancel: mutation((session) => session.cancel),
              newThread: nextWireEpoch().pipe(
                Effect.andThen(Ref.set(selected, { _tag: "latest" as const })),
                Effect.andThen(mutation((session) => session.newThread)),
              ),
              resolvePermission: (waitId, kind, decision) =>
                mutation((session) => session.resolvePermission(waitId, kind, decision)),
              selectThread: (threadId, selectionEpoch) =>
                Effect.gen(function* () {
                  const epoch = yield* nextWireEpoch(selectionEpoch)
                  yield* Ref.set(selected, { _tag: "thread" as const, threadId })
                  yield* retryRead((session) => session.selectThread(threadId, epoch))
                }),
              readQueue: (threadId) => retryRead((session) => session.readQueue(threadId)),
              loadOlder: retryRead((session) => session.loadOlder),
              previewThread: (threadId) => retryRead((session) => session.previewThread(threadId)),
              reopenThread: (selectionEpoch) =>
                Effect.gen(function* () {
                  const epoch = yield* nextWireEpoch(selectionEpoch)
                  yield* Ref.set(selected, { _tag: "latest" as const })
                  yield* retryRead((session) => session.reopenThread(epoch))
                }),
              replay: (turnId, afterCursor) => retryRead((session) => session.replay(turnId, afterCursor)),
            }
            const publish = (session: Operation.InteractiveSession, first: boolean) =>
              Effect.gen(function* () {
                if (!first) {
                  const selection = yield* Ref.get(selected)
                  const epoch = yield* nextWireEpoch()
                  if (selection?._tag === "thread") yield* session.selectThread(selection.threadId, epoch)
                  else if (selection?._tag === "latest") yield* session.reopenThread(epoch)
                }
                const changed = yield* Ref.modify(sessions, (state) => [state.changed, { ...state, session }])
                yield* Deferred.succeed(changed, undefined)
                if (first) yield* Deferred.succeed(firstSession, undefined)
              })
            const runPhysical = (connection: ResidentService.Connection, first: boolean) =>
              connection
                .run(operationInput, {
                  interactive: (_, session) => publish(session, first).pipe(Effect.andThen(connection.closed)),
                })
                .pipe(Effect.ensuring(connection.close))
            let nextReconnectDelay = yield* Schedule.toStepWithMetadata(reconnectSchedule)
            const loop = (
              connection: ResidentService.Connection | undefined,
              first: boolean,
              consecutiveFailures: number,
            ): Effect.Effect<
              void,
              | ResidentService.ResidentServiceError
              | ResidentService.ResidentRestartRequired
              | Operation.OperationUnavailable
            > =>
              Effect.gen(function* () {
                const acquired = yield* Effect.exit(
                  connection === undefined ? acquireReady("reattach") : Effect.succeed(connection),
                )
                if (acquired._tag === "Failure")
                  return yield* recover(acquired.cause, undefined, first, consecutiveFailures)
                const startedAt = yield* Clock.currentTimeMillis
                const outcome = yield* Effect.exit(runPhysical(acquired.value, first))
                const duration = (yield* Clock.currentTimeMillis) - startedAt
                if (outcome._tag === "Success") return
                return yield* recover(outcome.cause, duration, first, consecutiveFailures, acquired.value.connectionId)
              })
            const recover = (
              cause: Cause.Cause<
                | ResidentService.ResidentServiceError
                | ResidentService.ResidentRestartRequired
                | Operation.OperationUnavailable
              >,
              duration: number | undefined,
              first: boolean,
              consecutiveFailures: number,
              connectionId?: string,
            ): Effect.Effect<
              void,
              | ResidentService.ResidentServiceError
              | ResidentService.ResidentRestartRequired
              | Operation.OperationUnavailable
            > =>
              Effect.gen(function* () {
                if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause)
                const failure = Cause.squash(cause)
                if (
                  Schema.is(ResidentService.ResidentRestartRequired)(failure) ||
                  (Schema.is(ResidentService.ResidentServiceError)(failure) &&
                    failure.reason === "incompatible-resident")
                ) {
                  const selection = yield* Ref.get(selected)
                  return yield* ResidentService.ResidentRestartRequired.make({
                    message: failure.message,
                    ...(selection?._tag === "thread" ? { threadId: selection.threadId } : {}),
                  })
                }
                if (!isDisconnectedOperation(failure) && !isReconnectableTransport(failure))
                  return yield* Effect.failCause(cause)
                const current = (yield* Ref.get(sessions)).session
                if (current !== undefined) yield* invalidate(current)
                const stableConnection = duration !== undefined && duration >= reconnectStableMilliseconds
                const nextFailure = stableConnection ? 1 : consecutiveFailures + 1
                if (stableConnection) nextReconnectDelay = yield* Schedule.toStepWithMetadata(reconnectSchedule)
                if (nextFailure >= reconnectFailureLimit) {
                  yield* Effect.logError("resident.connection.reconnect_exhausted").pipe(
                    Effect.annotateLogs({
                      "rika.failure.kind": failureKind(cause),
                      "rika.resident.connection.duration.ms": duration ?? 0,
                      "rika.resident.connection.failures": nextFailure,
                      ...(connectionId === undefined ? {} : { "rika.resident.connection.id": connectionId }),
                    }),
                  )
                  return yield* Operation.OperationUnavailable.make({
                    operation: "ResidentConnection",
                    message: `Resident connection closed ${nextFailure} times before becoming stable`,
                  })
                }
                const delay = yield* nextReconnectDelay(failure).pipe(Effect.orDie)
                yield* Effect.logWarning("resident.connection.reconnecting").pipe(
                  Effect.annotateLogs({
                    "rika.failure.kind": failureKind(cause),
                    "rika.resident.connection.duration.ms": duration ?? 0,
                    "rika.resident.connection.retry": nextFailure,
                    "rika.resident.connection.retry_delay.ms": Duration.toMillis(delay.duration),
                    ...(connectionId === undefined ? {} : { "rika.resident.connection.id": connectionId }),
                  }),
                )
                const nextFirst = first && !(yield* Deferred.isDone(firstSession))
                return yield* loop(undefined, nextFirst, nextFailure)
              })
            const supervisor = yield* Effect.forkChild(
              Effect.raceFirst(loop(initial, true, 0), Deferred.await(logicalClosed)),
            )
            yield* Effect.raceFirst(
              Deferred.await(firstSession),
              Effect.raceFirst(Deferred.await(logicalClosed), Fiber.join(supervisor)),
            )
            yield* Effect.raceFirst(
              interactive(operationInput, stable),
              Effect.raceFirst(Deferred.await(logicalClosed), Fiber.join(supervisor)),
            ).pipe(Effect.ensuring(Fiber.interrupt(supervisor)))
          })
          return {
            ...initial,
            run: (operationInput, options) =>
              operationInput._tag === "Interactive" && options?.interactive !== undefined
                ? supervise(operationInput, options.interactive)
                : initial.run(operationInput, options),
            closed: Deferred.await(logicalClosed),
            close: Deferred.succeed(logicalClosed, undefined).pipe(
              Effect.andThen(Scope.close(connectionScope, Exit.void)),
            ),
          } satisfies ResidentService.Connection
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(ResidentService.ResidentServiceError)(cause) ||
            Schema.is(ResidentService.ResidentRestartRequired)(cause)
              ? cause
              : transportError(String(cause)),
          ),
        ),
    }),
  ),
)

export const layer = Layer.effect(ResidentService.Service, make())
