import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as Operation from "@rika/app/operation-contract"
import * as InteractiveFeedOverflow from "@rika/app/interactive-feed-overflow"
import * as ResidentService from "@rika/app/resident-service"
import {
  Cause,
  Clock,
  Config,
  Console,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  FileSystem,
  Formatter,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import { readOrCreateToken, resolve } from "./resident-endpoint"
import { releaseAdoptedStartup } from "./resident-startup"
import {
  decodeClient,
  defaultOutboundCapacity,
  failureKind,
  json,
  makeClientMessageFrameDecoder,
  maxFrameBytes,
  outputFrames,
  parse,
  serverMessageFrames,
  transportError,
} from "./resident-wire"

const interactiveFeedInFlightCapacity = 32

const formatOutput = (values: ReadonlyArray<unknown>) =>
  `${values.map((value) => (typeof value === "string" ? value : Formatter.format(value))).join(" ")}\n`

const host = Effect.fn("ResidentTransport.host")(function* (options: {
  readonly port: number
  readonly identity: string
  readonly token: string
  readonly graceMilliseconds: number
  readonly ownerDrainMilliseconds: number
  readonly startupHoldMilliseconds: number
  readonly outboundCapacity: number
  readonly stopped: Deferred.Deferred<void>
  readonly ready: Deferred.Deferred<void>
  readonly onReady: Effect.Effect<void, ResidentService.ResidentServiceError, FileSystem.FileSystem>
  readonly owner: ResidentService.Owner
}) {
  const crypto = yield* Crypto.Crypto
  const baseConsole = yield* Console.Console
  const hostScope = yield* Effect.scope
  const serviceNonce = yield* crypto.randomUUIDv4
  const graceFiber = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)
  const coldCohortUntil = yield* Ref.make(0)
  const lifecycle = yield* ResidentService.makeLifecycle(() => Effect.void)
  const hostWork = yield* FiberSet.make<void, unknown>()
  const activeConnections = yield* Ref.make(new Map<string, Effect.Effect<void>>())
  const operationAdmission = yield* Semaphore.make(32)
  const drainingFailure = (requestId: string, operation: string) =>
    writerFailure(
      requestId,
      Operation.OperationUnavailable.make({ operation, message: "Resident service is draining" }),
    )
  const writerFailure = (requestId: string, error: Operation.OperationUnavailable) =>
    json({ _tag: "operation-failed", requestId, error } satisfies ResidentService.ServerMessage)
  const scheduleGrace = (generation: number, delay = options.graceMilliseconds) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const cohortUntil = yield* Ref.get(coldCohortUntil)
      const effectiveDelay = Math.max(delay, cohortUntil - now)
      const fiber = yield* Effect.forkIn(
        Effect.sleep(effectiveDelay).pipe(
          Effect.andThen(lifecycle.expireGrace(generation)),
          Effect.flatMap((draining) => (draining ? Deferred.succeed(options.stopped, undefined) : Effect.void)),
          Effect.asVoid,
        ),
        hostScope,
      )
      yield* Ref.set(graceFiber, fiber)
    })
  const requestByInput = new WeakMap<object, { readonly requestId: string; readonly routeKey: string }>()
  type ResidentSession = {
    readonly session: Operation.InteractiveSession
    readonly ended: Deferred.Deferred<void>
    readonly feedGeneration: string
    readonly commands: Map<number, Deferred.Deferred<void>>
    readonly commandReleases: Map<number, Effect.Effect<void>>
    readonly commandQueue: Queue.Queue<{
      readonly sequence: number
      readonly cancelled: Deferred.Deferred<void>
      readonly effect: Effect.Effect<void, Operation.OperationUnavailable | ResidentService.ResidentServiceError>
    }>
    readonly acceptCommand: (sequence: number) => boolean
    readonly acknowledge: (throughSequence: number) => Effect.Effect<boolean>
    readonly replay: (afterSequence: number) => Effect.Effect<void>
  }
  const routes = yield* Ref.make(
    new Map<
      string,
      {
        readonly connectionId: string
        readonly send: (text: string) => Effect.Effect<void, Operation.OperationUnavailable>
        readonly sendFrames: (frames: ReadonlyArray<string>) => Effect.Effect<void, Operation.OperationUnavailable>
        readonly sessions: Map<string, ResidentSession>
      }
    >(),
  )
  const interactive = Effect.fn("ResidentTransport.interactive")(function* (
    input: ResidentService.InteractiveInput,
    session: Operation.InteractiveSession,
  ) {
    const request = requestByInput.get(input)
    if (request === undefined)
      return yield* Operation.OperationUnavailable.make({
        operation: "Interactive",
        message: "Missing interactive request",
      })
    const { requestId, routeKey } = request
    const route = (yield* Ref.get(routes)).get(routeKey)
    if (route === undefined)
      return yield* Operation.OperationUnavailable.make({
        operation: "Interactive",
        message: "Interactive client disconnected",
      })
    const sessionId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((error) =>
        Operation.OperationUnavailable.make({ operation: "Interactive", message: String(error) }),
      ),
    )
    const feedGeneration = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((error) =>
        Operation.OperationUnavailable.make({ operation: "Interactive", message: String(error) }),
      ),
    )
    const ended = yield* Deferred.make<void>()
    const feed = yield* Queue.bounded<
      | { readonly _tag: "Event"; readonly event: Operation.InteractiveEvent }
      | { readonly _tag: "Replay"; readonly afterSequence: number }
      | { readonly _tag: "Overflow" }
    >(options.outboundCapacity)
    const inFlightCapacity = Math.min(options.outboundCapacity, interactiveFeedInFlightCapacity)
    const sendPermits = yield* Queue.bounded<void>(inFlightCapacity)
    for (let index = 0; index < inFlightCapacity; index += 1) yield* Queue.offer(sendPermits, undefined)
    const feedAdmission = yield* Semaphore.make(1)
    const replayWindow = new Map<
      number,
      { readonly frames: ReadonlyArray<string>; readonly detail: boolean; readonly barrier: boolean }
    >()
    const barrierAcknowledgements = new Map<number, Deferred.Deferred<void>>()
    const commands = new Map<number, Deferred.Deferred<void>>()
    const commandReleases = new Map<number, Effect.Effect<void>>()
    const commandQueue = yield* Queue.bounded<{
      readonly sequence: number
      readonly cancelled: Deferred.Deferred<void>
      readonly effect: Effect.Effect<void, Operation.OperationUnavailable | ResidentService.ResidentServiceError>
    }>(options.outboundCapacity)
    let nextCommandSequence = 1
    let nextSequence = 1
    let acknowledgedThrough = 0
    let highestSent = 0
    let replayFloor = 1
    let outstandingDetails = 0
    let selectedThreadId: string | undefined
    let selectionEpoch = 0
    let overflow: InteractiveFeedOverflow.State | undefined
    let sentDetails = 0
    const rememberSelection = (event: Operation.InteractiveEvent) => {
      let threadId: string | undefined
      if (event._tag === "SelectionLoaded") threadId = String(event.thread.id)
      else if ("threadId" in event && event.threadId !== undefined) threadId = String(event.threadId)
      if (threadId !== undefined) selectedThreadId = threadId
      if ("selectionEpoch" in event) selectionEpoch = event.selectionEpoch
      return threadId
    }
    const remember = (state: InteractiveFeedOverflow.State, event: Operation.InteractiveEvent) => {
      rememberSelection(event)
      InteractiveFeedOverflow.remember(state, event)
    }
    const dispatch = (event: Operation.InteractiveEvent) => {
      if (overflow !== undefined) {
        remember(overflow, event)
        return
      }
      if (outstandingDetails >= options.outboundCapacity || !Queue.offerUnsafe(feed, { _tag: "Event", event })) {
        overflow = InteractiveFeedOverflow.make()
        remember(overflow, event)
        Queue.offerUnsafe(feed, { _tag: "Overflow" })
        return
      }
      outstandingDetails += 1
      rememberSelection(event)
    }
    const recoveryEvents = (state: InteractiveFeedOverflow.State, reason: string) =>
      InteractiveFeedOverflow.events(state, selectionEpoch, reason)
    const genericRecovery = (reason: string) => {
      const state = InteractiveFeedOverflow.make()
      if (selectedThreadId !== undefined) {
        state.transcriptThreadIds.add(selectedThreadId)
        state.queueThreadIds.add(selectedThreadId)
      }
      return recoveryEvents(state, reason)
    }
    const sendNew = (
      makeMessage: (sequence: number) => ResidentService.ServerMessage,
      detail: boolean,
      barrier: boolean,
    ) =>
      Effect.gen(function* () {
        yield* Queue.take(sendPermits)
        const sequence = yield* feedAdmission.withPermits(1)(
          Effect.sync(() => {
            const current = nextSequence
            nextSequence += 1
            highestSent = current
            return current
          }),
        )
        const message = makeMessage(sequence)
        const frames = yield* Effect.try({
          try: () => serverMessageFrames(`${feedGeneration}:${sequence}`, message),
          catch: (error) =>
            Operation.OperationUnavailable.make({
              operation: "InteractiveSession.events",
              message: String(error),
            }),
        })
        replayWindow.set(sequence, { frames, detail, barrier })
        if (barrier) replayFloor = sequence
        if (frames.length > 1)
          yield* Effect.logInfo("resident.feed.message_fragmented").pipe(
            Effect.annotateLogs({
              "rika.resident.feed.sequence": sequence,
              "rika.resident.feed.fragments": frames.length,
            }),
          )
        yield* route.sendFrames(frames)
        return sequence
      })
    const sendBarrier = (events: ReadonlyArray<Operation.InteractiveEvent>) =>
      Effect.gen(function* () {
        const sequence = yield* sendNew(
          (messageSequence) => ({
            _tag: "interactive-feed-resync",
            connectionId: route.connectionId,
            requestId,
            sessionId,
            feedGeneration,
            sequence: messageSequence,
            events,
          }),
          false,
          true,
        )
        yield* Effect.logInfo("resident.feed.barrier_sent")
        const acknowledged = yield* Deferred.make<void>()
        const alreadyAcknowledged = yield* feedAdmission.withPermits(1)(
          Effect.sync(() => {
            if (acknowledgedThrough >= sequence) return true
            barrierAcknowledgements.set(sequence, acknowledged)
            return false
          }),
        )
        if (!alreadyAcknowledged) yield* Deferred.await(acknowledged)
      })
    const sender = Effect.gen(function* () {
      while (true) {
        const item = yield* Queue.take(feed)
        if (item._tag === "Event")
          yield* sendNew(
            (sequence) => ({
              _tag: "interactive-feed-event",
              connectionId: route.connectionId,
              requestId,
              sessionId,
              feedGeneration,
              sequence,
              event: item.event,
            }),
            true,
            false,
          )
        else if (item._tag === "Replay") {
          const outsideWindow = item.afterSequence < replayFloor - 1
          if (outsideWindow) {
            const retainedBarrier = replayWindow.get(replayFloor)
            if (retainedBarrier !== undefined && retainedBarrier.barrier)
              yield* route.sendFrames(retainedBarrier.frames)
            else
              yield* sendBarrier(
                genericRecovery("Resident replay request fell outside its bounded current-session window"),
              )
          } else
            for (const [sequence, frame] of replayWindow)
              if (sequence > item.afterSequence && sequence >= replayFloor) yield* route.sendFrames(frame.frames)
        }
        if (item._tag === "Event") {
          sentDetails += 1
          if (sentDetails % 1_024 === 0)
            yield* Effect.logInfo("resident.feed.detail_sent").pipe(
              Effect.annotateLogs({
                "rika.resident.feed.sent": sentDetails,
                "rika.resident.feed.queued": yield* Queue.size(feed),
                "rika.resident.feed.overflowed": overflow !== undefined,
              }),
            )
        }
        if ((yield* Queue.size(feed)) === 0 && overflow !== undefined) {
          const state = overflow
          overflow = undefined
          const reason = state.criticalOverflowed
            ? "Resident event feed exceeded its bounded non-recoverable event capacity"
            : "Resident event feed exceeded its bounded current-session window"
          const events = recoveryEvents(state, reason)
          yield* sendBarrier(state.criticalOverflowed ? [...events, ...genericRecovery(reason)] : events)
          if (state.criticalOverflowed)
            return yield* Operation.OperationUnavailable.make({
              operation: "InteractiveSession.events",
              message: reason,
            })
        }
      }
    })
    const acknowledge = (throughSequence: number) =>
      feedAdmission.withPermits(1)(
        Effect.gen(function* () {
          if (throughSequence <= acknowledgedThrough) return true
          if (throughSequence > highestSent) return false
          let released = 0
          for (const [sequence, frame] of replayWindow) {
            if (sequence > throughSequence) break
            replayWindow.delete(sequence)
            released += 1
            if (frame.detail) outstandingDetails -= 1
          }
          acknowledgedThrough = throughSequence
          for (const [sequence, acknowledged] of barrierAcknowledgements) {
            if (sequence > throughSequence) break
            barrierAcknowledgements.delete(sequence)
            yield* Deferred.succeed(acknowledged, undefined)
          }
          for (let index = 0; index < released; index += 1) yield* Queue.offer(sendPermits, undefined)
          return true
        }),
      )
    const residentSession: ResidentSession = {
      session,
      ended,
      feedGeneration,
      commands,
      commandReleases,
      commandQueue,
      acceptCommand: (sequence) => {
        if (sequence !== nextCommandSequence) return false
        nextCommandSequence += 1
        return true
      },
      acknowledge,
      replay: (afterSequence) => Queue.offer(feed, { _tag: "Replay", afterSequence }).pipe(Effect.asVoid),
    }
    route.sessions.set(sessionId, residentSession)
    yield* route.send(
      json({
        _tag: "interactive-started",
        connectionId: route.connectionId,
        requestId,
        sessionId,
        feedGeneration,
        feedCapacity: options.outboundCapacity,
      } satisfies ResidentService.ServerMessage),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        const source = yield* Effect.forkChild(session.events(dispatch))
        const delivery = yield* Effect.forkChild(sender)
        const commandWorker = yield* Effect.forkChild(
          Effect.forever(
            Queue.take(commandQueue).pipe(
              Effect.orDie,
              Effect.flatMap((command) =>
                Effect.raceFirst(Deferred.await(command.cancelled), command.effect).pipe(
                  Effect.mapError((failure) =>
                    Schema.is(Operation.OperationUnavailable)(failure)
                      ? failure
                      : Operation.OperationUnavailable.make({
                          operation: "InteractiveSession.command",
                          message: failure.message,
                        }),
                  ),
                  Effect.ensuring(
                    Effect.sync(() => {
                      if (commands.get(command.sequence) === command.cancelled) commands.delete(command.sequence)
                    }),
                  ),
                ),
              ),
            ),
          ),
        )
        yield* Effect.raceFirst(
          Deferred.await(ended),
          Effect.raceFirst(Fiber.join(source), Effect.raceFirst(Fiber.join(delivery), Fiber.join(commandWorker))),
        )
      }),
    ).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          route.sessions.delete(sessionId)
          for (const command of commands.values()) yield* Deferred.succeed(command, undefined)
          for (const release of commandReleases.values()) yield* release
          commands.clear()
          commandReleases.clear()
          yield* Queue.shutdown(commandQueue)
          yield* Queue.shutdown(feed)
          yield* Queue.shutdown(sendPermits)
        }),
      ),
    )
  })
  const ownerScope = yield* Scope.make()
  const serverScope = yield* Scope.make()
  const hardExit = (reason: string) =>
    Effect.logError("resident.shutdown.hard_exit").pipe(
      Effect.annotateLogs("rika.resident.shutdown.reason", reason),
      Effect.andThen(Effect.sync(() => process.exit(typeof process.exitCode === "number" ? process.exitCode : 143))),
      Effect.asVoid,
    )
  yield* Effect.addFinalizer((exit) =>
    lifecycle.beginDrain.pipe(
      Effect.andThen(FiberSet.clear(hostWork)),
      Effect.andThen(
        Effect.raceFirst(
          FiberSet.awaitEmpty(hostWork).pipe(Effect.andThen(Scope.close(ownerScope, exit))),
          Effect.sleep(options.ownerDrainMilliseconds).pipe(
            Effect.andThen(hardExit(`owner drain exceeded ${options.ownerDrainMilliseconds}ms`)),
          ),
        ),
      ),
      Effect.andThen(
        Ref.get(activeConnections).pipe(
          Effect.flatMap((connections) =>
            Effect.forEach(
              connections.values(),
              (close) =>
                close.pipe(
                  Effect.timeoutOrElse({
                    duration: "250 millis",
                    orElse: () => Effect.logWarning("resident.shutdown.connection_close.timeout").pipe(Effect.asVoid),
                  }),
                ),
              { concurrency: "unbounded", discard: true },
            ),
          ),
        ),
      ),
      Effect.andThen(
        Scope.close(serverScope, exit).pipe(
          Effect.timeoutOrElse({
            duration: "500 millis",
            orElse: () => Effect.logWarning("resident.shutdown.server_close.timeout").pipe(Effect.asVoid),
          }),
        ),
      ),
    ),
  )
  const server = yield* Scope.provide(BunHttpServer.make({ hostname: "127.0.0.1", port: options.port }), serverScope)
  const operationReady = yield* Deferred.make<Operation.Interface>()
  const hasActiveExecutionWork = Deferred.await(operationReady).pipe(
    Effect.flatMap((operation) =>
      operation.authorizeResidentReplacement !== undefined
        ? operation.authorizeResidentReplacement.pipe(Effect.map((disposition) => disposition === "defer"))
        : (operation.hasActiveExecutionWork ?? Effect.succeed(true)),
    ),
    Effect.catch((error) =>
      Effect.logError("resident.replacement.status_failed").pipe(
        Effect.annotateLogs("rika.failure.kind", String(error)),
        Effect.as(true),
      ),
    ),
  )
  const handle = Effect.fn("ResidentTransport.connection")(function* (socket: Socket.Socket) {
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
    const routeKey = (requestId: string) => `${connectionId}\0${requestId}`
    const close = (code: number, reason?: string) => writer(new Socket.CloseEvent(code, reason))
    yield* Ref.update(activeConnections, (current) =>
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
                    Effect.flatMap(Schema.decodeUnknownEffect(ResidentService.HandshakeV3)),
                    Effect.mapError(() => transportError("Invalid legacy resident request")),
                  ),
                )
                if (
                  legacy._tag === "Success" &&
                  ResidentService.validateHandshakeV3(legacy.success, {
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
              const result = ResidentService.validateHandshake(message, {
                identity: options.identity,
                token: options.token,
                buildIdentity: ResidentService.buildIdentity,
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
                    replacementGuard: ResidentService.replacementGuard,
                    family: "rika-resident" as const,
                    identity: options.identity,
                    clientNonce: message.clientNonce,
                    serviceNonce,
                    connectionId,
                    protocolVersion: ResidentService.protocolVersion,
                    buildIdentity: ResidentService.buildIdentity,
                    residentPid: process.pid,
                  }
                  yield* writer(
                    json({
                      ...response,
                      serverProof: ResidentService.serverProof(options.token, message, response),
                    } satisfies ResidentService.HandshakeIncompatible),
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
                  json({ _tag: "rejected", reason: "draining" } satisfies ResidentService.HandshakeRejected),
                )
                return yield* close(4409)
              }
              yield* Ref.set(attached, true)
              const existing = yield* Ref.get(graceFiber)
              if (existing !== undefined) yield* Fiber.interrupt(existing)
              yield* Ref.set(graceFiber, undefined)
              const response = {
                _tag: "accepted" as const,
                family: "rika-resident" as const,
                identity: options.identity,
                clientNonce: message.clientNonce,
                serviceNonce,
                connectionId,
                protocolVersion: ResidentService.protocolVersion,
                buildIdentity: ResidentService.buildIdentity,
                residentPid: process.pid,
              }
              const acceptedProof = ResidentService.serverProof(options.token, message, response)
              yield* writer(
                json({
                  ...response,
                  serverProof: acceptedProof,
                } satisfies ResidentService.HandshakeAccepted),
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
              const active = (yield* Ref.get(routes)).get(routeKey(message.requestId))?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration
              )
                return yield* close(4400)
              yield* Deferred.succeed(active.ended, undefined)
            }
            if (message._tag === "cancel-interactive-command") {
              const active = (yield* Ref.get(routes)).get(routeKey(message.requestId))?.sessions.get(message.sessionId)
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
              const active = (yield* Ref.get(routes)).get(routeKey(message.requestId))?.sessions.get(message.sessionId)
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
              const active = (yield* Ref.get(routes)).get(routeKey(message.requestId))?.sessions.get(message.sessionId)
              if (
                message.connectionId !== connectionId ||
                active === undefined ||
                active.feedGeneration !== message.feedGeneration
              )
                return yield* close(4400)
              yield* active.replay(message.afterSequence)
            }
            if (message._tag === "interactive-command") {
              const active = (yield* Ref.get(routes)).get(routeKey(message.requestId))?.sessions.get(message.sessionId)
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
                    error: Operation.OperationUnavailable.make({
                      operation: message.command._tag,
                      message: "Resident service is draining",
                    }),
                  } satisfies ResidentService.ServerMessage),
                )
                return
              }
              const cancelled = yield* Deferred.make<void>()
              const effect = Effect.gen(function* () {
                yield* Operation.executeInteractiveCommand(active.session, message.command)
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
                          "rika.failure.kind": failure._tag,
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
                          error: Schema.is(Operation.OperationUnavailable)(failure)
                            ? failure
                            : Operation.OperationUnavailable.make({
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
              if (message.command._tag === "ResolvePermission" || message.command._tag === "Cancel")
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
            if (message._tag === "operation") {
              if ((yield* Ref.get(requests)).has(message.requestId)) return yield* close(4400)
              yield* Effect.logInfo("resident.operation.accepted").pipe(
                Effect.annotateLogs({
                  "rika.operation": message.input._tag,
                  "rika.resident.request.id": message.requestId,
                }),
              )
              const requestRouteKey = routeKey(message.requestId)
              requestByInput.set(message.input, { requestId: message.requestId, routeKey: requestRouteKey })
              const send = (frame: string) =>
                writer(frame).pipe(
                  Effect.mapError((error) =>
                    Operation.OperationUnavailable.make({
                      operation: "ResidentConnection",
                      message: error.message,
                    }),
                  ),
                )
              const sendFrames = (frames: ReadonlyArray<string>) =>
                outboundMessages.withPermits(1)(Effect.forEach(frames, send, { discard: true }))
              yield* Ref.update(routes, (current) =>
                current.set(requestRouteKey, {
                  connectionId,
                  send,
                  sendFrames,
                  sessions: new Map(),
                }),
              )
              const started = yield* Deferred.make<void>()
              const fiber = yield* lifecycle.runWork(
                hostWork,
                Deferred.await(started).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      const startedAt = yield* Clock.currentTimeMillis
                      const output = yield* Queue.bounded<
                        | { readonly _tag: "output"; readonly channel: "stdout" | "stderr"; readonly text: string }
                        | { readonly _tag: "finished" }
                      >(options.outboundCapacity)
                      let outputOverflowed = false
                      const write = (channel: "stdout" | "stderr", values: ReadonlyArray<unknown>) => {
                        if (!Queue.offerUnsafe(output, { _tag: "output", channel, text: formatOutput(values) }))
                          outputOverflowed = true
                      }
                      const requestConsole = Object.assign(Object.create(baseConsole) as Console.Console, {
                        assert: (condition: boolean, ...values: ReadonlyArray<unknown>) => {
                          if (!condition) write("stderr", values)
                        },
                        debug: (...values: ReadonlyArray<unknown>) => write("stdout", values),
                        error: (...values: ReadonlyArray<unknown>) => write("stderr", values),
                        info: (...values: ReadonlyArray<unknown>) => write("stdout", values),
                        log: (...values: ReadonlyArray<unknown>) => write("stdout", values),
                        warn: (...values: ReadonlyArray<unknown>) => write("stderr", values),
                      })
                      const sender = yield* Effect.forkChild(
                        Effect.gen(function* () {
                          while (true) {
                            const frame = yield* Queue.take(output)
                            if (frame._tag === "finished") return
                            for (const encoded of outputFrames(message.requestId, frame.channel, frame.text))
                              yield* send(encoded)
                          }
                        }),
                      )
                      const operation = yield* Deferred.await(operationReady)
                      const execution = operation
                        .run(message.input)
                        .pipe(Effect.provideService(Console.Console, requestConsole))
                      const result = yield* Effect.exit(
                        message.input._tag === "Interactive" ? execution : operationAdmission.withPermits(1)(execution),
                      )
                      const delivery = yield* Effect.raceFirst(
                        Fiber.await(sender),
                        Queue.offer(output, { _tag: "finished" }).pipe(Effect.andThen(Fiber.await(sender))),
                      )
                      let outcome
                      if (Exit.isFailure(delivery))
                        outcome = Exit.fail(
                          Operation.OperationUnavailable.make({
                            operation: message.input._tag,
                            message: `Resident output delivery failed: ${Cause.pretty(delivery.cause)}`,
                          }),
                        )
                      else if (outputOverflowed)
                        outcome = Exit.fail(
                          Operation.OperationUnavailable.make({
                            operation: message.input._tag,
                            message: "Resident client output queue is overloaded",
                          }),
                        )
                      else outcome = result
                      yield* Exit.match(outcome, {
                        onFailure: (cause) => {
                          const failure = Cause.squash(cause)
                          const error = Schema.is(Operation.OperationUnavailable)(failure)
                            ? failure
                            : Operation.OperationUnavailable.make({
                                operation: message.input._tag,
                                message: String(failure),
                              })
                          return Clock.currentTimeMillis.pipe(
                            Effect.flatMap((failedAt) =>
                              Effect.logError("resident.operation.failed").pipe(
                                Effect.annotateLogs({
                                  "rika.duration.ms": failedAt - startedAt,
                                  "rika.failure.kind": failureKind(cause),
                                }),
                              ),
                            ),
                            Effect.andThen(
                              send(
                                json({
                                  _tag: "operation-failed",
                                  requestId: message.requestId,
                                  error,
                                } satisfies ResidentService.ServerMessage),
                              ).pipe(Effect.catch(() => rawWriter(new Socket.CloseEvent(1011)).pipe(Effect.ignore))),
                            ),
                          )
                        },
                        onSuccess: () =>
                          Clock.currentTimeMillis.pipe(
                            Effect.flatMap((completedAt) =>
                              Effect.logInfo("resident.operation.completed").pipe(
                                Effect.annotateLogs("rika.duration.ms", completedAt - startedAt),
                              ),
                            ),
                            Effect.andThen(
                              send(
                                json({
                                  _tag: "operation-completed",
                                  requestId: message.requestId,
                                } satisfies ResidentService.ServerMessage),
                              ).pipe(Effect.catch(() => rawWriter(new Socket.CloseEvent(1011)).pipe(Effect.ignore))),
                            ),
                          ),
                      })
                    }).pipe(
                      Effect.annotateLogs({
                        "rika.operation": message.input._tag,
                        "rika.resident.connection.id": connectionId,
                        "rika.resident.request.id": message.requestId,
                      }),
                      Effect.ensuring(
                        Ref.update(requests, (current) => (current.delete(message.requestId), current)).pipe(
                          Effect.andThen(Ref.update(routes, (current) => (current.delete(requestRouteKey), current))),
                          Effect.andThen(Effect.sync(() => requestByInput.delete(message.input))),
                        ),
                      ),
                      Effect.asVoid,
                    ),
                  ),
                ),
                message.input._tag !== "Interactive",
              )
              if (fiber === undefined) {
                yield* Ref.update(routes, (current) => (current.delete(requestRouteKey), current))
                requestByInput.delete(message.input)
                yield* writer(drainingFailure(message.requestId, message.input._tag))
                return
              }
              yield* Ref.update(requests, (current) => current.set(message.requestId, fiber))
              yield* Deferred.succeed(started, undefined)
            }
          }),
        ),
      )
      .pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Ref.update(activeConnections, (current) => (current.delete(connectionId), current))
            if (!(yield* Ref.get(attached))) return
            const activeRequests = yield* Ref.get(requests)
            const activeRoutes = yield* Ref.get(routes)
            for (const requestId of activeRequests.keys()) {
              const route = activeRoutes.get(routeKey(requestId))
              if (route === undefined) continue
              for (const session of route.sessions.values()) {
                for (const command of session.commands.values()) yield* Deferred.succeed(command, undefined)
                yield* Deferred.succeed(session.ended, undefined)
              }
            }
            for (const fiber of activeRequests.values()) yield* Fiber.interrupt(fiber)
            yield* Ref.update(routes, (current) => {
              for (const requestId of activeRequests.keys()) current.delete(routeKey(requestId))
              return current
            })
            const generation = yield* lifecycle.detach
            yield* Effect.logInfo("resident.connection.closed").pipe(
              Effect.annotateLogs("rika.resident.connection.id", connectionId),
            )
            if (generation === undefined) return
            yield* scheduleGrace(generation)
            yield* Effect.logInfo("resident.idle-generation.started").pipe(
              Effect.annotateLogs({
                "rika.resident.connection.id": connectionId,
                "rika.resident.generation": generation,
              }),
            )
          }),
        ),
      )
  })

  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.url === "/resident/v1") {
      const socket = yield* request.upgrade
      yield* Effect.scoped(
        Effect.gen(function* () {
          const writer = yield* socket.writer
          yield* writer(new Socket.CloseEvent(4403, "Resident protocol upgrade required"))
        }),
      )
      return HttpServerResponse.empty()
    }
    if (request.url !== "/resident") return HttpServerResponse.empty({ status: 404 })
    const socket = yield* request.upgrade
    yield* handle(socket)
    return HttpServerResponse.empty()
  })
  yield* Scope.provide(server.serve(app), serverScope)
  const operation = yield* Scope.provide(options.owner(interactive), ownerScope)
  yield* Deferred.succeed(operationReady, operation)
  yield* Ref.set(coldCohortUntil, (yield* Clock.currentTimeMillis) + options.startupHoldMilliseconds)
  const startupGrace = yield* lifecycle.ready
  if (startupGrace !== undefined) yield* scheduleGrace(startupGrace)
  yield* options.onReady
  yield* Effect.logInfo("resident.listener.ready")
  yield* Deferred.succeed(options.ready, undefined)
  yield* Deferred.await(options.stopped)
})

export const serve = Effect.fn("ResidentTransport.serve")(function* (options: {
  readonly profile: string
  readonly dataRoot: string
  readonly graceMilliseconds?: number
  readonly ownerDrainMilliseconds?: number
  readonly startupHoldMilliseconds?: number
  readonly outboundCapacity?: number
  readonly onReady?: Effect.Effect<void, ResidentService.ResidentServiceError, FileSystem.FileSystem>
  readonly owner: ResidentService.Owner
}) {
  const endpoint = yield* resolve(options.profile, options.dataRoot)
  const token = yield* readOrCreateToken(endpoint.tokenPath)
  const ownerDrainMilliseconds =
    options.ownerDrainMilliseconds ??
    Number(yield* Config.string("RIKA_INTERNAL_RESIDENT_OWNER_DRAIN").pipe(Config.withDefault("5000")))
  const stopped = yield* Deferred.make<void>()
  const ready = yield* Deferred.make<void>()
  yield* Effect.forkChild(
    Deferred.await(ready).pipe(
      Effect.andThen(releaseAdoptedStartup(endpoint.startupPath, endpoint.identity, process.pid)),
    ),
  )
  yield* host({
    ...endpoint,
    token,
    graceMilliseconds: options.graceMilliseconds ?? 500,
    ownerDrainMilliseconds,
    startupHoldMilliseconds: options.startupHoldMilliseconds ?? 10_000,
    outboundCapacity: Math.max(1, Math.floor(options.outboundCapacity ?? defaultOutboundCapacity)),
    stopped,
    ready,
    onReady: options.onReady ?? Effect.void,
    owner: options.owner,
  }).pipe(Effect.ensuring(releaseAdoptedStartup(endpoint.startupPath, endpoint.identity, process.pid)))
})
