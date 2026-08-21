import {
  ClientMessage,
  type ClientTicketResponse,
  protocolVersion,
  ServerFrame,
  type ServerFrame as ServerFrameValue,
} from "@rika/product/client-protocol"
import {
  CommandId,
  IdempotencyKey,
  ProjectId,
  RequestId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
} from "@rika/product/hosted-model"
import { Deferred, Effect, Layer, Queue, Schema } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { HostedError, HostedThreadId, ThreadClient, type ThreadClientInterface } from "./hosted-contract"

const encodeClientMessage = Schema.encodeSync(Schema.fromJsonString(ClientMessage))
const decodeServerFrame = Schema.decodeUnknownEffect(Schema.fromJsonString(ServerFrame))

const failure = (kind: HostedError["kind"], message: string) => HostedError.make({ kind, message })

const rejection = (payload: Extract<ServerFrameValue["payload"], { readonly _tag: "CommandRejected" }>) => {
  let kind: HostedError["kind"] = "protocol"
  if (payload.reason === "forbidden") kind = "denied"
  if (payload.reason === "unavailable") kind = "network"
  return failure(kind, payload.message)
}

export const connect = Effect.fn("HostedThreadClient.connect")(function* (ticket: ClientTicketResponse) {
  const socket = yield* Socket.makeWebSocket(ticket.websocketUrl, {
    protocols: [ticket.protocol, `rika.ticket.${ticket.ticket}`],
    openTimeout: "30 seconds",
  })
  const writer = yield* socket.writer
  const frames = yield* Queue.bounded<ServerFrameValue>(1_024)
  const opened = yield* Deferred.make<void, HostedError>()
  const disconnected = yield* Deferred.make<never, HostedError>()
  const disconnectedEffect = Deferred.await(disconnected)
  const whileConnected = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.raceFirst(effect, disconnectedEffect)

  yield* socket
    .runString(
      (value) =>
        decodeServerFrame(value).pipe(
          Effect.mapError(() => failure("protocol", "Hosted Thread server sent an invalid frame")),
          Effect.flatMap((frame) => Queue.offer(frames, frame)),
        ),
      { onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid) },
    )
    .pipe(
      Effect.catch((error) =>
        Deferred.fail(
          disconnected,
          Schema.is(HostedError)(error) ? error : failure("network", "Hosted Thread connection was interrupted"),
        ).pipe(Effect.asVoid),
      ),
      Effect.ensuring(
        Deferred.fail(disconnected, failure("network", "Hosted Thread connection closed")).pipe(Effect.ignore),
      ),
      Effect.forkScoped,
    )

  yield* whileConnected(Deferred.await(opened))

  const send = (message: ClientMessage) =>
    Effect.try({
      try: () => encodeClientMessage(message),
      catch: () => failure("protocol", "Hosted Thread command could not be encoded"),
    }).pipe(
      Effect.flatMap(writer),
      Effect.mapError((error) =>
        Schema.is(HostedError)(error) ? error : failure("network", "Hosted Thread command could not be sent"),
      ),
      whileConnected,
    )

  const next = whileConnected(Queue.take(frames))

  return { send, next }
})

const envelope = (requestId: string, command: ClientMessage["command"]): ClientMessage => ({
  protocolVersion,
  requestId: RequestId.make(requestId),
  command,
})

const awaitCommand = Effect.fn("HostedThreadClient.awaitCommand")(function* (
  connection: Effect.Success<ReturnType<typeof connect>>,
  requestId: string,
  commandId: string,
) {
  while (true) {
    const payload = (yield* connection.next).payload
    if (
      (payload._tag === "CommandAccepted" || payload._tag === "CommandRejected") &&
      payload.requestId === requestId &&
      payload.commandId === commandId
    ) {
      if (payload._tag === "CommandRejected") return yield* rejection(payload)
      return payload
    }
  }
})

const attach = Effect.fn("HostedThreadClient.attach")(function* (
  connection: Effect.Success<ReturnType<typeof connect>>,
  threadId: string,
  requestId: string,
) {
  yield* connection.send(
    envelope(requestId, {
      _tag: "AttachThread",
      threadId: ThreadId.make(threadId),
      afterCursor: ThreadEventCursor.make("0"),
    }),
  )
  while (true) {
    const payload = (yield* connection.next).payload
    if (payload._tag === "CommandRejected" && payload.requestId === requestId) return yield* rejection(payload)
    if (payload._tag === "ThreadSnapshot" && payload.requestId === requestId) return payload
  }
})

export const layer = Layer.effect(
  ThreadClient,
  Effect.gen(function* () {
    const webSocketConstructor = yield* Socket.WebSocketConstructor
    return ThreadClient.of({
      create: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(input.ticket)
            const requestId = `${input.commandId}:create`
            yield* connection.send(
              envelope(requestId, {
                _tag: "CreateThread",
                commandId: CommandId.make(input.commandId),
                idempotencyKey: IdempotencyKey.make(input.commandId),
                expectedThreadVersion: ThreadVersion.make("0"),
                owner:
                  input.owner.kind === "personal"
                    ? { kind: "personal" }
                    : { kind: "organization", organizationId: input.owner.organizationId },
                ...(input.project === undefined ? {} : { projectId: ProjectId.make(input.project) }),
                executorKind: input.executorKind,
                ...(input.localRunnerTarget === undefined ? {} : { localRunnerTarget: input.localRunnerTarget }),
              }),
            )
            const accepted = yield* awaitCommand(connection, requestId, input.commandId)
            if (accepted.result._tag !== "ThreadCreated")
              return yield* failure("protocol", "Hosted Thread creation returned the wrong result")
            return HostedThreadId.make(String(accepted.result.threadId))
          }),
        ).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)),
      submit: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const text = input.request.prompt.join("\n").trim()
            if (text.length === 0) return yield* failure("invalid-input", "Hosted prompt must not be empty")
            const connection = yield* connect(input.ticket)
            const snapshot = yield* attach(connection, input.threadId, `${input.commandId}:attach`)
            const requestId = `${input.commandId}:submit`
            yield* connection.send(
              envelope(requestId, {
                _tag: "SubmitPrompt",
                commandId: CommandId.make(input.commandId),
                idempotencyKey: IdempotencyKey.make(input.commandId),
                expectedThreadVersion: snapshot.threadVersion,
                text,
                ...(input.request.mode === undefined ? {} : { mode: input.request.mode }),
              }),
            )
            const accepted = yield* awaitCommand(connection, requestId, input.commandId)
            if (accepted.result._tag !== "Applied")
              return yield* failure("protocol", "Hosted prompt returned the wrong result")
            return { commandId: input.commandId, status: "queued" as const }
          }),
        ).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)),
    } satisfies ThreadClientInterface)
  }),
)
