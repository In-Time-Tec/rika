import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunSocket from "@effect/platform-bun/BunSocket"
import { Operation, ResidentService } from "@rika/app"
import * as Thread from "@rika/persistence/thread"
import {
  Cause,
  Clock,
  Console,
  Context,
  Crypto,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Formatter,
  Function,
  Layer,
  Queue,
  Ref,
  Schedule,
  Schema,
  Scope,
  Semaphore,
} from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process"
import * as Socket from "effect/unstable/socket/Socket"
import { readOrCreateToken, resolve } from "./resident-endpoint"

const decodeClient = Schema.decodeUnknownSync(ResidentService.ClientMessage)
const decodeServer = Schema.decodeUnknownSync(ResidentService.ServerMessage)
const transportError = (message: string, reason: ResidentService.ResidentServiceError["reason"] = "transport-failed") =>
  ResidentService.ResidentServiceError.make({ reason, message })
const mapResidentSocketFailure = (cause: unknown, accepted: boolean): ResidentService.ResidentServiceError => {
  if (Socket.SocketError.is(cause) && cause.reason._tag === "SocketCloseError") {
    if (cause.reason.code === 4403) return transportError("Resident protocol upgrade required", "upgrade-required")
    if (cause.reason.code === 4409) return transportError("Resident service is draining", "resident-draining")
    if (cause.reason.code === 4401) return transportError("Foreign resident listener", "foreign-listener")
  }
  return transportError(String(cause), accepted ? "transport-failed" : "resident-absent")
}
export const residentSocketFailure: {
  (accepted: boolean): (cause: unknown) => ResidentService.ResidentServiceError
  (cause: unknown, accepted: boolean): ResidentService.ResidentServiceError
} = Function.dual(2, mapResidentSocketFailure)
const json = Schema.encodeSync(Schema.UnknownFromJsonString)
const parse = Schema.decodeSync(Schema.UnknownFromJsonString)
const capabilities = ["ping", "startup-state", "transcript-pages", "interactive-ack"] as const

export const supportsCurrentResidentCapabilities = (available: ReadonlyArray<string>): boolean =>
  capabilities.every((capability) => available.includes(capability))
const maxFrameBytes = 1_048_576
const defaultOutboundCapacity = 1_024
const failureKind = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.squash(cause)
  if (failure !== null && typeof failure === "object" && "_tag" in failure && typeof failure._tag === "string")
    return failure._tag
  if (failure instanceof Error) return failure.name
  return typeof failure
}
const isDisconnectedOperation = (error: unknown) =>
  Schema.is(Operation.OperationUnavailable)(error) && error.operation === "ResidentConnection"
const isReconnectableTransport = (error: unknown) =>
  Schema.is(ResidentService.ResidentServiceError)(error) &&
  (error.reason === "resident-absent" || error.reason === "resident-draining" || error.reason === "transport-failed")
const formatOutput = (values: ReadonlyArray<unknown>) =>
  `${values.map((value) => (typeof value === "string" ? value : Formatter.format(value))).join(" ")}\n`

const host = Effect.fn("ResidentTransport.host")(function* (options: {
  readonly port: number
  readonly identity: string
  readonly token: string
  readonly graceMilliseconds: number
  readonly outboundCapacity: number
  readonly stopped: Deferred.Deferred<void>
  readonly ready: Deferred.Deferred<void>
  readonly owner: NonNullable<Parameters<ResidentService.Interface["getOrCreate"]>[0]["owner"]>
}) {
  const crypto = yield* Crypto.Crypto
  const baseConsole = yield* Console.Console
  const hostScope = yield* Effect.scope
  const server = yield* BunHttpServer.make({ hostname: "127.0.0.1", port: options.port })
  const operationReady = yield* Deferred.make<Operation.Interface>()
  const serviceNonce = yield* crypto.randomUUIDv4
  const graceFiber = yield* Ref.make<Fiber.Fiber<void> | undefined>(undefined)
  const lifecycle = yield* ResidentService.makeLifecycle(() => Effect.void)
  const hostWork = yield* FiberSet.make<void, unknown>()
  const drainingFailure = (requestId: string, operation: string) =>
    writerFailure(
      requestId,
      Operation.OperationUnavailable.make({ operation, message: "Resident service is draining" }),
    )
  const writerFailure = (requestId: string, error: Operation.OperationUnavailable) =>
    json({ _tag: "operation-failed", requestId, error } satisfies ResidentService.ServerMessage)
  const scheduleGrace = (generation: number) =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkIn(
        Effect.sleep(options.graceMilliseconds).pipe(
          Effect.andThen(lifecycle.expireGrace(generation)),
          Effect.flatMap((draining) => (draining ? Deferred.succeed(options.stopped, undefined) : Effect.void)),
          Effect.asVoid,
        ),
        hostScope,
      )
      yield* Ref.set(graceFiber, fiber)
    })
  const requestByInput = new WeakMap<object, string>()
  const routes = yield* Ref.make(
    new Map<
      string,
      {
        readonly send: (text: string) => Effect.Effect<void>
        readonly sessions: Map<string, { session: Operation.InteractiveSession; ended: Deferred.Deferred<void> }>
      }
    >(),
  )
  const interactive = Effect.fn("ResidentTransport.interactive")(function* (
    input: ResidentService.InteractiveInput,
    session: Operation.InteractiveSession,
  ) {
    const requestId = requestByInput.get(input)
    if (requestId === undefined)
      return yield* Operation.OperationUnavailable.make({
        operation: "Interactive",
        message: "Missing interactive request",
      })
    const route = (yield* Ref.get(routes)).get(requestId)
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
    const ended = yield* Deferred.make<void>()
    route.sessions.set(sessionId, { session, ended })
    yield* route.send(
      json({ _tag: "interactive-started", requestId, sessionId } satisfies ResidentService.ServerMessage),
    )
    yield* Deferred.await(ended).pipe(Effect.ensuring(Effect.sync(() => route.sessions.delete(sessionId))))
  })
  const handle = Effect.fn("ResidentTransport.connection")(function* (socket: Socket.Socket) {
    const rawWriter = yield* socket.writer
    const outbound = yield* Queue.bounded<string | Socket.CloseEvent>(options.outboundCapacity)
    const writer = (frame: string | Socket.CloseEvent) =>
      typeof frame === "string" && new TextEncoder().encode(frame).byteLength > maxFrameBytes
        ? Effect.fail(transportError("Resident frame exceeds maximum size"))
        : Queue.offer(outbound, frame).pipe(
            Effect.timeoutOrElse({
              duration: "1 second",
              orElse: () => Effect.fail(transportError("Resident outbound queue is overloaded")),
            }),
            Effect.asVoid,
          )
    yield* Effect.forkChild(Effect.forever(Queue.take(outbound).pipe(Effect.flatMap(rawWriter))))
    const inbound = yield* Semaphore.make(1)
    const attached = yield* Ref.make(false)
    const requests = yield* Ref.make(new Map<string, Fiber.Fiber<void, unknown>>())
    const actions = yield* Ref.make(
      new Map<
        string,
        {
          readonly requestId: string
          readonly sessionId: string
          readonly fiber: Fiber.Fiber<void, unknown>
          readonly acknowledge: (deliveryId: string) => void
        }
      >(),
    )
    const connectionId = yield* crypto.randomUUIDv4
    const close = (code: number) => writer(new Socket.CloseEvent(code))
    yield* socket
      .runString((text) =>
        inbound.withPermits(1)(
          Effect.gen(function* () {
            if (new TextEncoder().encode(text).byteLength > maxFrameBytes) return yield* close(4400)
            const decoded = yield* Effect.result(
              Effect.try({
                try: () => decodeClient(parse(text)),
                catch: () => transportError("Invalid resident request"),
              }),
            )
            if (decoded._tag === "Failure") return yield* close(4400)
            const message = decoded.success
            if (!(yield* Ref.get(attached))) {
              if (!("family" in message)) return yield* close(4401)
              const result = ResidentService.validateHandshake(message, {
                identity: options.identity,
                token: options.token,
                capabilities,
              })
              if (result._tag !== "Accepted")
                return yield* close(
                  result._tag === "UpgradeRequired" || result._tag === "CapabilityMismatch" ? 4403 : 4401,
                )
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
              yield* writer(
                json({
                  _tag: "accepted",
                  family: "rika-resident",
                  version: ResidentService.protocolVersion,
                  identity: options.identity,
                  clientNonce: message.clientNonce,
                  serviceNonce,
                  connectionId,
                  state: "starting",
                  capabilities,
                } satisfies ResidentService.HandshakeAccepted),
              )
              yield* Deferred.await(operationReady)
              yield* writer(json({ _tag: "startup-ready" } satisfies ResidentService.ServerMessage))
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
              const active = (yield* Ref.get(routes)).get(message.requestId)?.sessions.get(message.sessionId)
              if (active !== undefined) yield* Deferred.succeed(active.ended, undefined)
            }
            if (message._tag === "cancel-interactive-action") {
              const active = (yield* Ref.get(actions)).get(message.actionId)
              if (
                active !== undefined &&
                active.requestId === message.requestId &&
                active.sessionId === message.sessionId
              )
                yield* Fiber.interrupt(active.fiber)
            }
            if (message._tag === "interactive-ack") {
              const active = (yield* Ref.get(actions)).get(message.actionId)
              if (
                active !== undefined &&
                active.requestId === message.requestId &&
                active.sessionId === message.sessionId
              )
                active.acknowledge(message.deliveryId)
            }
            if (message._tag === "interactive-action") {
              const active = (yield* Ref.get(routes)).get(message.requestId)?.sessions.get(message.sessionId)
              if (active === undefined) return
              const startedAt = yield* Clock.currentTimeMillis
              yield* Effect.logInfo("resident.interactive_action.accepted").pipe(
                Effect.annotateLogs({
                  "rika.resident.request.id": message.requestId,
                  "rika.resident.session.id": message.sessionId,
                  "rika.resident.action.id": message.actionId,
                  "rika.resident.action.method": message.method,
                }),
              )
              let outputOverflowed = false
              let dispatchedEvents = 0
              let overflowAt: number | undefined
              let overflowThreadId: Thread.ThreadId | undefined
              const unacknowledged = new Set<string>()
              const overflow = yield* Queue.bounded<{ readonly threadId?: Thread.ThreadId }>(1)
              const markOverflow = (event: Operation.InteractiveEvent) => {
                outputOverflowed = true
                overflowAt ??= dispatchedEvents
                if ("threadId" in event && event.threadId !== undefined)
                  overflowThreadId ??= Thread.ThreadId.make(String(event.threadId))
                Queue.offerUnsafe(overflow, overflowThreadId === undefined ? {} : { threadId: overflowThreadId })
              }
              const dispatch = (event: Operation.InteractiveEvent) => {
                if (outputOverflowed) return
                dispatchedEvents += 1
                if (unacknowledged.size >= options.outboundCapacity) {
                  markOverflow(event)
                  return
                }
                const deliveryId = `${message.actionId}:${dispatchedEvents}`
                if (
                  !Queue.offerUnsafe(
                    outbound,
                    json({
                      _tag: "interactive-event",
                      version: ResidentService.protocolVersion,
                      requestId: message.requestId,
                      sessionId: message.sessionId,
                      actionId: message.actionId,
                      deliveryId,
                      event,
                    } satisfies ResidentService.ServerMessage),
                  )
                ) {
                  markOverflow(event)
                  return
                }
                unacknowledged.add(deliveryId)
              }
              const args = message.arguments
              const action = (() => {
                switch (message.method) {
                  case "initialize":
                    return active.session.initialize(dispatch)
                  case "watchThreads":
                    return active.session.watchThreads(dispatch)
                  case "submit":
                    return active.session.submit(
                      args[0] as string,
                      dispatch,
                      args[1] as "low" | "medium" | "high" | "ultra" | undefined,
                      args[2] as ReadonlyArray<import("@rika/persistence/turn").PromptPart> | undefined,
                      args[3] as { readonly reasoningEffort?: string; readonly fastMode?: boolean } | undefined,
                    )
                  case "shell":
                    return active.session.shell(args[0] as string, args[1] as boolean, dispatch)
                  case "editQueued":
                    return active.session.editQueued(args[0] as string, args[1] as string, dispatch)
                  case "dequeue":
                    return active.session.dequeue(args[0] as string, dispatch)
                  case "steerQueued":
                    return active.session.steerQueued(args[0] as string, args[1] as string, dispatch)
                  case "steer":
                    return active.session.steer(args[0] as string, dispatch)
                  case "interruptAndSend":
                    return active.session.interruptAndSend(args[0] as string, dispatch)
                  case "cancel":
                    return active.session.cancel(dispatch)
                  case "resolvePermission":
                    return active.session.resolvePermission(
                      args[0] as string,
                      args[1] as "permission" | "tool-approval",
                      args[2] as "allow" | "deny" | "always",
                      dispatch,
                    )
                  case "selectThread":
                    return active.session.selectThread(args[0] as string, dispatch)
                  case "loadOlder":
                    return active.session.loadOlder(dispatch)
                  case "previewThread":
                    return active.session.previewThread(args[0] as string, dispatch)
                  case "reopenThread":
                    return active.session.reopenThread(dispatch)
                  case "followSelected":
                    return active.session.followSelected(dispatch)
                  case "replay":
                    return active.session.replay(args[0] as string, args[1] as string | undefined, dispatch)
                  default:
                    return Effect.void
                }
              })()
              const started = yield* Deferred.make<void>()
              const actionFiber = yield* lifecycle.runWork(
                hostWork,
                Deferred.await(started).pipe(
                  Effect.andThen(
                    Effect.raceFirst(
                      action.pipe(Effect.as("completed" as const)),
                      Queue.take(overflow).pipe(Effect.as("overflow" as const)),
                    ).pipe(
                      Effect.flatMap(
                        (
                          outcome,
                        ): Effect.Effect<
                          void,
                          ResidentService.ResidentServiceError | Operation.OperationUnavailable
                        > =>
                          outcome === "overflow" || outputOverflowed
                            ? Effect.gen(function* () {
                                if (overflowThreadId !== undefined)
                                  yield* writer(
                                    json({
                                      _tag: "interactive-event",
                                      version: ResidentService.protocolVersion,
                                      requestId: message.requestId,
                                      sessionId: message.sessionId,
                                      actionId: message.actionId,
                                      event: {
                                        _tag: "TranscriptResyncRequired",
                                        threadId: overflowThreadId,
                                        reason: "Resident transcript delivery overflowed its bounded queue",
                                      },
                                    } satisfies ResidentService.ServerMessage),
                                  )
                                return yield* Operation.OperationUnavailable.make({
                                  operation: message.method,
                                  message: "Resident client is too slow to receive interactive events",
                                })
                              })
                            : Clock.currentTimeMillis.pipe(
                                Effect.flatMap((completedAt) =>
                                  Effect.logInfo("resident.interactive_action.completed").pipe(
                                    Effect.annotateLogs({
                                      "rika.resident.request.id": message.requestId,
                                      "rika.resident.session.id": message.sessionId,
                                      "rika.resident.action.id": message.actionId,
                                      "rika.resident.action.method": message.method,
                                      "rika.resident.action.event_count": dispatchedEvents,
                                      "rika.duration.ms": completedAt - startedAt,
                                    }),
                                  ),
                                ),
                                Effect.andThen(
                                  writer(
                                    json({
                                      _tag: "action-completed",
                                      requestId: message.requestId,
                                      sessionId: message.sessionId,
                                      actionId: message.actionId,
                                    } satisfies ResidentService.ServerMessage),
                                  ),
                                ),
                              ),
                      ),
                      Effect.asVoid,
                    ),
                  ),
                  Effect.catch((failure) =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((failedAt) =>
                        Effect.logError("resident.interactive_action.failed").pipe(
                          Effect.annotateLogs({
                            "rika.resident.request.id": message.requestId,
                            "rika.resident.session.id": message.sessionId,
                            "rika.resident.action.id": message.actionId,
                            "rika.resident.action.method": message.method,
                            "rika.resident.action.event_count": dispatchedEvents,
                            "rika.resident.action.queue_capacity": options.outboundCapacity,
                            ...(overflowAt === undefined ? {} : { "rika.resident.action.overflow_at": overflowAt }),
                            "rika.failure.kind": failure._tag,
                            "rika.duration.ms": failedAt - startedAt,
                          }),
                        ),
                      ),
                      Effect.andThen(
                        writer(
                          json({
                            _tag: "action-failed",
                            requestId: message.requestId,
                            sessionId: message.sessionId,
                            actionId: message.actionId,
                            error: Schema.is(Operation.OperationUnavailable)(failure)
                              ? failure
                              : Operation.OperationUnavailable.make({
                                  operation: message.method,
                                  message: String(failure),
                                }),
                          } satisfies ResidentService.ServerMessage),
                        ),
                      ),
                    ),
                  ),
                  Effect.ensuring(Ref.update(actions, (current) => (current.delete(message.actionId), current))),
                ),
              )
              if (actionFiber === undefined) {
                yield* writer(
                  json({
                    _tag: "action-failed",
                    requestId: message.requestId,
                    sessionId: message.sessionId,
                    actionId: message.actionId,
                    error: Operation.OperationUnavailable.make({
                      operation: message.method,
                      message: "Resident service is draining",
                    }),
                  } satisfies ResidentService.ServerMessage),
                )
                return
              }
              yield* Ref.update(actions, (current) =>
                current.set(message.actionId, {
                  requestId: message.requestId,
                  sessionId: message.sessionId,
                  fiber: actionFiber,
                  acknowledge: (deliveryId) => unacknowledged.delete(deliveryId),
                }),
              )
              yield* Deferred.succeed(started, undefined)
            }
            if (message._tag === "operation") {
              yield* Effect.logInfo("resident.operation.accepted").pipe(
                Effect.annotateLogs({
                  "rika.operation": message.input._tag,
                  "rika.resident.request.id": message.requestId,
                }),
              )
              requestByInput.set(message.input, message.requestId)
              const send = (frame: string) => writer(frame).pipe(Effect.ignore)
              yield* Ref.update(routes, (current) =>
                current.set(message.requestId, {
                  send,
                  sessions: new Map(),
                }),
              )
              const fiber = yield* lifecycle.runWork(
                hostWork,
                Effect.gen(function* () {
                  const startedAt = yield* Clock.currentTimeMillis
                  const operation = yield* Deferred.await(operationReady)
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
                        yield* send(
                          json({
                            _tag: "output",
                            requestId: message.requestId,
                            channel: frame.channel,
                            text: frame.text,
                          } satisfies ResidentService.ServerMessage),
                        )
                      }
                    }),
                  )
                  const result = yield* Effect.exit(
                    operation.run(message.input).pipe(Effect.provideService(Console.Console, requestConsole)),
                  )
                  yield* Queue.offer(output, { _tag: "finished" })
                  yield* Fiber.join(sender)
                  const outcome = outputOverflowed
                    ? Exit.fail(
                        Operation.OperationUnavailable.make({
                          operation: message.input._tag,
                          message: "Resident client output queue is overloaded",
                        }),
                      )
                    : result
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
                          ),
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
                          ),
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
                      Effect.andThen(Ref.update(routes, (current) => (current.delete(message.requestId), current))),
                      Effect.andThen(Effect.sync(() => requestByInput.delete(message.input))),
                    ),
                  ),
                  Effect.asVoid,
                ),
              )
              if (fiber === undefined) {
                yield* Ref.update(routes, (current) => (current.delete(message.requestId), current))
                requestByInput.delete(message.input)
                yield* writer(drainingFailure(message.requestId, message.input._tag))
                return
              }
              yield* Ref.update(requests, (current) => current.set(message.requestId, fiber))
            }
          }),
        ),
      )
      .pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            if (!(yield* Ref.get(attached))) return
            const activeRequests = yield* Ref.get(requests)
            for (const fiber of activeRequests.values()) yield* Fiber.interrupt(fiber)
            const activeActions = yield* Ref.get(actions)
            for (const action of activeActions.values()) yield* Fiber.interrupt(action.fiber)
            yield* Ref.update(routes, (current) => {
              for (const requestId of activeRequests.keys()) current.delete(requestId)
              return current
            })
            const generation = yield* lifecycle.detach
            if (generation === undefined) return
            yield* scheduleGrace(generation)
            yield* Effect.logInfo("resident.connection.closed").pipe(
              Effect.annotateLogs("rika.resident.connection.id", connectionId),
            )
          }),
        ),
      )
  })

  const app = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (request.url !== "/resident/v1") return HttpServerResponse.empty({ status: 404 })
    const socket = yield* request.upgrade
    yield* handle(socket)
    return HttpServerResponse.empty()
  })
  yield* server.serve(app)
  const ownerScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(ownerScope, exit))
  const operation = yield* Scope.provide(options.owner(interactive), ownerScope)
  yield* Effect.addFinalizer(() =>
    lifecycle.beginDrain.pipe(Effect.andThen(FiberSet.clear(hostWork)), Effect.andThen(FiberSet.awaitEmpty(hostWork))),
  )
  const startupGrace = yield* lifecycle.ready
  if (startupGrace !== undefined) yield* scheduleGrace(startupGrace)
  yield* Deferred.succeed(operationReady, operation)
  yield* Deferred.succeed(options.ready, undefined)
  yield* Deferred.await(options.stopped)
})

const connect = Effect.fn("ResidentTransport.connect")(function* (options: {
  readonly url: string
  readonly identity: string
  readonly token: string
  readonly clientKind: ResidentService.Handshake["clientKind"]
  readonly clientVersion: string
  readonly role: ResidentService.Connection["role"]
}) {
  const crypto = yield* Crypto.Crypto
  const connectionScope = yield* Scope.make()
  yield* Effect.addFinalizer(() => Scope.close(connectionScope, Exit.void))
  const webSocketContext = yield* Scope.provide(Layer.build(BunSocket.layerWebSocketConstructor), connectionScope)
  const webSocketConstructor = Context.get(webSocketContext, Socket.WebSocketConstructor)
  const socket = yield* Socket.makeWebSocket(options.url).pipe(
    Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
  )
  const rawWriter = yield* Scope.provide(socket.writer, connectionScope)
  const outbound = yield* Queue.bounded<string | Socket.CloseEvent>(defaultOutboundCapacity)
  const writer = (frame: string | Socket.CloseEvent) =>
    typeof frame === "string" && new TextEncoder().encode(frame).byteLength > maxFrameBytes
      ? Effect.fail(transportError("Resident frame exceeds maximum size"))
      : Queue.offer(outbound, frame).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.fail(transportError("Resident outbound queue is overloaded")),
          }),
          Effect.asVoid,
        )
  yield* Effect.forkIn(Effect.forever(Queue.take(outbound).pipe(Effect.flatMap(rawWriter))), connectionScope)
  const accepted = yield* Deferred.make<ResidentService.HandshakeAccepted>()
  const startup = yield* Deferred.make<void, ResidentService.ResidentServiceError>()
  const clientNonce = yield* crypto.randomUUIDv4
  const closed = yield* Deferred.make<void>()
  const connectionFailure = yield* Deferred.make<never, ResidentService.ResidentServiceError>()
  const pongs = yield* Ref.make(new Map<string, Deferred.Deferred<void, ResidentService.ResidentServiceError>>())
  const inbound = yield* Semaphore.make(1)
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
          readonly session: Operation.InteractiveSession
        }>
        readonly input: Operation.Input
        readonly actions: Map<
          string,
          {
            readonly done: Deferred.Deferred<void, Operation.OperationUnavailable>
            readonly dispatch: (event: Operation.InteractiveEvent) => void
          }
        >
      }
    >(),
  )
  const handshake = json({
    family: "rika-resident",
    version: ResidentService.protocolVersion,
    identity: options.identity,
    token: options.token,
    clientNonce,
    clientKind: options.clientKind,
    clientVersion: options.clientVersion,
    capabilities,
  } satisfies ResidentService.Handshake)
  yield* socket
    .runString(
      (frame) =>
        inbound.withPermits(1)(
          (new TextEncoder().encode(frame).byteLength > maxFrameBytes
            ? Effect.fail(transportError("Resident frame exceeds maximum size"))
            : Effect.try({
                try: () => decodeServer(parse(frame)),
                catch: () => transportError("Invalid resident response"),
              })
          ).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                for (const waiter of (yield* Ref.get(pongs)).values()) yield* Deferred.succeed(waiter, undefined)
              }),
            ),
            Effect.flatMap((message) =>
              message._tag === "accepted"
                ? message.identity !== options.identity || message.clientNonce !== clientNonce
                  ? Effect.fail(transportError("Foreign resident listener", "foreign-listener"))
                  : !ResidentService.isCurrentProtocolVersion(message.version) ||
                      !supportsCurrentResidentCapabilities(message.capabilities)
                    ? Deferred.fail(
                        connectionFailure,
                        transportError("Resident protocol upgrade required", "upgrade-required"),
                      )
                    : Deferred.succeed(accepted, message).pipe(
                        Effect.andThen(message.state === "ready" ? Deferred.succeed(startup, undefined) : Effect.void),
                      )
                : message._tag === "startup-ready"
                  ? Deferred.succeed(startup, undefined)
                  : message._tag === "startup-failed"
                    ? Deferred.fail(connectionFailure, transportError(message.error))
                    : message._tag === "rejected"
                      ? Deferred.fail(
                          connectionFailure,
                          transportError("Resident service is draining", "resident-draining"),
                        )
                      : message._tag === "pong"
                        ? Effect.gen(function* () {
                            const pending = (yield* Ref.get(pongs)).get(message.id)
                            if (pending !== undefined) yield* Deferred.succeed(pending, undefined)
                          })
                        : Effect.gen(function* () {
                            const request = (yield* Ref.get(requests)).get(message.requestId)
                            if (request === undefined) return
                            if (message._tag === "output")
                              yield* (message.channel === "stdout"
                                ? request.stdout?.(message.text)
                                : request.stderr?.(message.text)) ?? Effect.void
                            if (message._tag === "interactive-event") {
                              const action = request.actions.get(message.actionId)
                              if (action !== undefined) {
                                action.dispatch(message.event as Operation.InteractiveEvent)
                                if (message.deliveryId !== undefined)
                                  yield* writer(
                                    json({
                                      _tag: "interactive-ack",
                                      requestId: message.requestId,
                                      sessionId: message.sessionId,
                                      actionId: message.actionId,
                                      deliveryId: message.deliveryId,
                                    } satisfies ResidentService.ClientMessage),
                                  )
                              }
                            }
                            if (message._tag === "action-completed") {
                              const action = request.actions.get(message.actionId)
                              if (action !== undefined) yield* Deferred.succeed(action.done, undefined)
                            }
                            if (message._tag === "action-failed") {
                              const action = request.actions.get(message.actionId)
                              if (action !== undefined) yield* Deferred.fail(action.done, message.error)
                            }
                            if (
                              message._tag === "interactive-started" &&
                              request.input._tag === "Interactive" &&
                              request.interactive !== undefined
                            ) {
                              const invokeRaw = Effect.fn("ResidentTransport.interactiveAction")(function* (
                                method: string,
                                args: ReadonlyArray<unknown>,
                                dispatch: (event: Operation.InteractiveEvent) => void,
                              ) {
                                const actionId = yield* crypto.randomUUIDv4
                                const done = yield* Deferred.make<void, Operation.OperationUnavailable>()
                                request.actions.set(actionId, { done, dispatch })
                                yield* writer(
                                  json({
                                    _tag: "interactive-action",
                                    requestId: message.requestId,
                                    sessionId: message.sessionId,
                                    actionId,
                                    method,
                                    arguments: args,
                                  } satisfies ResidentService.ClientMessage),
                                ).pipe(Effect.ignore)
                                yield* Effect.raceFirst(
                                  Deferred.await(done),
                                  Deferred.await(closed).pipe(
                                    Effect.andThen(
                                      Effect.fail(
                                        Operation.OperationUnavailable.make({
                                          operation: "ResidentConnection",
                                          message: "Resident connection closed before the action outcome was known",
                                        }),
                                      ),
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
                                                _tag: "cancel-interactive-action",
                                                requestId: message.requestId,
                                                sessionId: message.sessionId,
                                                actionId,
                                              } satisfies ResidentService.ClientMessage),
                                            ),
                                      ),
                                      Effect.andThen(Effect.sync(() => request.actions.delete(actionId))),
                                    ),
                                  ),
                                )
                              })
                              const invoke = (
                                method: string,
                                args: ReadonlyArray<unknown>,
                                dispatch: (event: Operation.InteractiveEvent) => void,
                              ) => invokeRaw(method, args, dispatch).pipe(Effect.orDie)
                              const session: Operation.InteractiveSession = {
                                initialize: (dispatch) => invoke("initialize", [], dispatch),
                                watchThreads: (dispatch) => invoke("watchThreads", [], dispatch),
                                submit: (prompt, dispatch, mode, parts, tuning) =>
                                  invoke("submit", [prompt, mode, parts, tuning], dispatch),
                                shell: (command, incognito, dispatch) =>
                                  invoke("shell", [command, incognito], dispatch),
                                editQueued: (turnId, prompt, dispatch) =>
                                  invoke("editQueued", [turnId, prompt], dispatch),
                                dequeue: (turnId, dispatch) => invoke("dequeue", [turnId], dispatch),
                                steerQueued: (turnId, text, dispatch) =>
                                  invoke("steerQueued", [turnId, text], dispatch),
                                steer: (text, dispatch) => invoke("steer", [text], dispatch),
                                interruptAndSend: (prompt, dispatch) => invoke("interruptAndSend", [prompt], dispatch),
                                cancel: (dispatch) => invoke("cancel", [], dispatch),
                                resolvePermission: (waitId, kind, decision, dispatch) =>
                                  invoke("resolvePermission", [waitId, kind, decision], dispatch),
                                selectThread: (threadId, dispatch) => invoke("selectThread", [threadId], dispatch),
                                loadOlder: (dispatch) => invoke("loadOlder", [], dispatch),
                                previewThread: (threadId, dispatch) => invoke("previewThread", [threadId], dispatch),
                                reopenThread: (dispatch) => invoke("reopenThread", [], dispatch),
                                followSelected: (dispatch) => invoke("followSelected", [], dispatch),
                                replay: (turnId, afterCursor, dispatch) =>
                                  invoke("replay", [turnId, afterCursor], dispatch),
                              }
                              if (request.interactiveStarted !== undefined)
                                yield* Deferred.succeed(request.interactiveStarted, {
                                  sessionId: message.sessionId,
                                  session,
                                })
                            }
                            if (message._tag === "operation-completed") yield* Deferred.succeed(request.done, undefined)
                            if (message._tag === "operation-failed") yield* Deferred.fail(request.done, message.error)
                          }),
            ),
          ),
        ),
      { onOpen: writer(handshake).pipe(Effect.ignore) },
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
            for (const action of request.actions.values()) yield* Deferred.fail(action.done, operationFailure)
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
      duration: "15 seconds",
      orElse: () => Effect.fail(transportError("Resident startup timed out", "transport-failed")),
    }),
  )
  yield* Effect.raceFirst(Deferred.await(startup), disconnected).pipe(
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(transportError("Resident startup timed out", "transport-failed")),
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
      yield* writer(json({ _tag: "ping", id } satisfies ResidentService.ClientMessage))
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
  yield* Effect.forkIn(
    ping.pipe(
      Effect.repeat({ schedule: Schedule.spaced("5 seconds") }),
      Effect.catch((cause) => Deferred.fail(connectionFailure, cause)),
    ),
    connectionScope,
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
              : yield* Deferred.make<{ readonly sessionId: string; readonly session: Operation.InteractiveSession }>()
          yield* Ref.update(requests, (current) =>
            current.set(requestId, {
              done,
              ...(runOptions?.stdout === undefined ? {} : { stdout: runOptions.stdout }),
              ...(runOptions?.stderr === undefined ? {} : { stderr: runOptions.stderr }),
              ...(runOptions?.interactive === undefined ? {} : { interactive: runOptions.interactive }),
              ...(interactiveStarted === undefined ? {} : { interactiveStarted }),
              input,
              actions: new Map(),
            }),
          )
          yield* writer(json({ _tag: "operation", requestId, input } satisfies ResidentService.ClientMessage))
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
                    : whileConnected(
                        runOptions.interactive!(input as ResidentService.InteractiveInput, state.started.session),
                      ).pipe(
                        Effect.ensuring(
                          sendBestEffort(
                            json({
                              _tag: "interactive-end",
                              requestId,
                              sessionId: state.started.sessionId,
                            } satisfies ResidentService.ClientMessage),
                          ),
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
    close: sendBestEffort(new Socket.CloseEvent(1000)).pipe(Effect.ensuring(Scope.close(connectionScope, Exit.void))),
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
          const connectionScope = yield* Scope.make()
          yield* Effect.addFinalizer((exit) => Scope.close(connectionScope, exit))
          const attach = (role: ResidentService.Connection["role"]) =>
            Effect.gen(function* () {
              const attemptScope = yield* Scope.fork(connectionScope)
              const result = yield* Effect.exit(
                connect({ ...endpoint, ...input, token, role }).pipe(Scope.provide(attemptScope)),
              )
              if (result._tag === "Failure") {
                yield* Scope.close(attemptScope, result)
                return yield* Effect.failCause(result.cause)
              }
              return result.value
            })
          yield* Effect.logInfo("resident.connection.acquiring").pipe(
            Effect.annotateLogs("rika.resident.client.kind", input.clientKind),
          )
          const attachWhenReady = (role: ResidentService.Connection["role"]) =>
            attach(role).pipe(
              Effect.retry({
                times: 400,
                schedule: Schedule.spaced(25),
                while: (error) => error.reason === "resident-draining" || error.reason === "upgrade-required",
              }),
            )
          const acquire = Effect.fn("ResidentTransport.acquireConnection")(function* () {
            let first = yield* Effect.result(attachWhenReady("attached"))
            if (first._tag === "Success") return first.success
            if (first.failure.reason === "upgrade-required")
              return yield* transportError(
                "An older Rika resident is still active; close other Rika clients and retry",
                "upgrade-required",
              )
            if (first.failure.reason !== "resident-absent") return yield* first.failure
            if (input.startHost === undefined && input.owner === undefined) return yield* first.failure
            if (input.startHost !== undefined) {
              yield* input.startHost()
              return yield* attach("attached").pipe(Effect.retry({ times: 400, schedule: Schedule.spaced(25) }))
            }
            const stopped = yield* Deferred.make<void>()
            const ready = yield* Deferred.make<void>()
            if (input.owner === undefined) return yield* transportError("Resident owner operation layer is unavailable")
            const owner = yield* host({
              ...endpoint,
              token,
              graceMilliseconds: input.graceMilliseconds ?? 500,
              outboundCapacity: defaultOutboundCapacity,
              stopped,
              ready,
              owner: input.owner,
            }).pipe(Effect.scoped, Effect.exit, Effect.forkDetach)
            const ownsListener = yield* Effect.raceFirst(
              Deferred.await(ready).pipe(Effect.as(true)),
              Fiber.join(owner).pipe(Effect.as(false)),
            )
            return yield* attach(ownsListener ? "owner" : "attached").pipe(
              Effect.retry({ times: 20, schedule: Schedule.spaced(25) }),
              Effect.catch(() => attach("attached")),
            )
          })
          const acquireReady = acquire().pipe(
            Scope.provide(connectionScope),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
            Effect.provideService(Crypto.Crypto, crypto),
            Effect.mapError((error) =>
              Schema.is(ResidentService.ResidentServiceError)(error) ? error : transportError(String(error)),
            ),
            Effect.tapError((error) =>
              Effect.logWarning("resident.connection.failed").pipe(
                Effect.annotateLogs({
                  "rika.failure.kind": error._tag,
                  "rika.failure.reason": error.reason,
                  "rika.resident.client.kind": input.clientKind,
                }),
              ),
            ),
          )
          const initial = yield* acquireReady
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
            const initialized = yield* Ref.make<((event: Operation.InteractiveEvent) => void) | undefined>(undefined)
            const selected = yield* Ref.make<
              { readonly threadId: string; readonly dispatch: (event: Operation.InteractiveEvent) => void } | undefined
            >(undefined)
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
            const retryRead = (
              dispatch: (event: Operation.InteractiveEvent) => void,
              invoke: (session: Operation.InteractiveSession) => Effect.Effect<void>,
            ): Effect.Effect<void> =>
              Effect.suspend(() =>
                awaitSession.pipe(
                  Effect.flatMap((session) =>
                    invoke(session).pipe(
                      Effect.catchCause((cause) =>
                        Cause.hasInterruptsOnly(cause)
                          ? Effect.failCause(cause)
                          : isDisconnectedOperation(Cause.squash(cause))
                            ? invalidate(session).pipe(Effect.andThen(retryRead(dispatch, invoke)))
                            : Effect.sync(() =>
                                dispatch({ _tag: "ExecutionFailed", message: String(Cause.squash(cause)) }),
                              ),
                      ),
                    ),
                  ),
                ),
              )
            const mutation = (
              dispatch: (event: Operation.InteractiveEvent) => void,
              invoke: (session: Operation.InteractiveSession) => Effect.Effect<void>,
            ) =>
              awaitSession.pipe(
                Effect.flatMap((session) =>
                  invoke(session).pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause)
                        ? Effect.failCause(cause)
                        : isDisconnectedOperation(Cause.squash(cause))
                          ? invalidate(session).pipe(
                              Effect.andThen(
                                Effect.sync(() =>
                                  dispatch({
                                    _tag: "ExecutionFailed",
                                    message:
                                      "Resident transport disconnected; the action outcome is unknown and was not retried",
                                  }),
                                ),
                              ),
                            )
                          : Effect.sync(() =>
                              dispatch({ _tag: "ExecutionFailed", message: String(Cause.squash(cause)) }),
                            ),
                    ),
                  ),
                ),
              )
            const stable: Operation.InteractiveSession = {
              initialize: (dispatch) =>
                Ref.set(initialized, dispatch).pipe(
                  Effect.andThen(retryRead(dispatch, (session) => session.initialize(dispatch))),
                ),
              watchThreads: (dispatch) => retryRead(dispatch, (session) => session.watchThreads(dispatch)),
              submit: (prompt, dispatch, mode, parts, tuning) =>
                mutation(dispatch, (session) => session.submit(prompt, dispatch, mode, parts, tuning)),
              shell: (command, incognito, dispatch) =>
                mutation(dispatch, (session) => session.shell(command, incognito, dispatch)),
              editQueued: (turnId, prompt, dispatch) =>
                mutation(dispatch, (session) => session.editQueued(turnId, prompt, dispatch)),
              dequeue: (turnId, dispatch) => mutation(dispatch, (session) => session.dequeue(turnId, dispatch)),
              steerQueued: (turnId, text, dispatch) =>
                mutation(dispatch, (session) => session.steerQueued(turnId, text, dispatch)),
              steer: (text, dispatch) => mutation(dispatch, (session) => session.steer(text, dispatch)),
              interruptAndSend: (prompt, dispatch) =>
                mutation(dispatch, (session) => session.interruptAndSend(prompt, dispatch)),
              cancel: (dispatch) => mutation(dispatch, (session) => session.cancel(dispatch)),
              resolvePermission: (waitId, kind, decision, dispatch) =>
                mutation(dispatch, (session) => session.resolvePermission(waitId, kind, decision, dispatch)),
              selectThread: (threadId, dispatch) =>
                Ref.set(selected, { threadId, dispatch }).pipe(
                  Effect.andThen(retryRead(dispatch, (session) => session.selectThread(threadId, dispatch))),
                ),
              loadOlder: (dispatch) => retryRead(dispatch, (session) => session.loadOlder(dispatch)),
              previewThread: (threadId, dispatch) =>
                retryRead(dispatch, (session) => session.previewThread(threadId, dispatch)),
              reopenThread: (dispatch) => retryRead(dispatch, (session) => session.reopenThread(dispatch)),
              followSelected: (dispatch) => retryRead(dispatch, (session) => session.followSelected(dispatch)),
              replay: (turnId, afterCursor, dispatch) =>
                retryRead(dispatch, (session) => session.replay(turnId, afterCursor, dispatch)),
            }
            const publish = (session: Operation.InteractiveSession, first: boolean) =>
              Effect.gen(function* () {
                if (!first) {
                  const initializeDispatch = yield* Ref.get(initialized)
                  if (initializeDispatch !== undefined) yield* session.initialize(initializeDispatch)
                  const selection = yield* Ref.get(selected)
                  if (selection !== undefined) yield* session.selectThread(selection.threadId, selection.dispatch)
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
            const reconnect = (
              attempt: number,
            ): Effect.Effect<void, ResidentService.ResidentServiceError | Operation.OperationUnavailable> =>
              Effect.sleep(Math.min(1_000, 25 * 2 ** Math.min(attempt, 6))).pipe(
                Effect.andThen(acquireReady),
                Effect.flatMap((next) => loop(next, false)),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : isReconnectableTransport(Cause.squash(cause))
                      ? reconnect(attempt + 1)
                      : Effect.failCause(cause),
                ),
              )
            const loop = (
              connection: ResidentService.Connection,
              first: boolean,
            ): Effect.Effect<void, ResidentService.ResidentServiceError | Operation.OperationUnavailable> =>
              runPhysical(connection, first).pipe(
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.interrupt
                    : isDisconnectedOperation(Cause.squash(cause)) || isReconnectableTransport(Cause.squash(cause))
                      ? Effect.gen(function* () {
                          const current = (yield* Ref.get(sessions)).session
                          if (current !== undefined) yield* invalidate(current)
                          return yield* reconnect(0)
                        })
                      : Effect.failCause(cause),
                ),
              )
            const supervisor = yield* Effect.forkChild(
              Effect.raceFirst(loop(initial, true), Deferred.await(logicalClosed)),
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
            Schema.is(ResidentService.ResidentServiceError)(cause) ? cause : transportError(String(cause)),
          ),
        ),
    }),
  ),
)

export const layer = Layer.effect(ResidentService.Service, make())

export const serve = Effect.fn("ResidentTransport.serve")(function* (options: {
  readonly profile: string
  readonly dataRoot: string
  readonly graceMilliseconds?: number
  readonly outboundCapacity?: number
  readonly owner: NonNullable<Parameters<ResidentService.Interface["getOrCreate"]>[0]["owner"]>
}) {
  const endpoint = yield* resolve(options.profile, options.dataRoot)
  const token = yield* readOrCreateToken(endpoint.tokenPath)
  const stopped = yield* Deferred.make<void>()
  const ready = yield* Deferred.make<void>()
  yield* host({
    ...endpoint,
    token,
    graceMilliseconds: options.graceMilliseconds ?? 500,
    outboundCapacity: Math.max(1, Math.floor(options.outboundCapacity ?? defaultOutboundCapacity)),
    stopped,
    ready,
    owner: options.owner,
  })
})
