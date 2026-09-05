import {
  ClientMessage,
  type ClientTicketResponse,
  protocolMismatchMessage,
  protocolVersion,
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
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type * as TranscriptUnit from "@rika/transcript/transcript-unit"
import { Deferred, Effect, Layer, Queue, Schema } from "effect"
import * as Socket from "effect/unstable/socket/Socket"
import { HostedError, HostedThreadId, ThreadClient, type ThreadClientInterface } from "./contract"
import { decodeThreadFrame } from "./thread-client/frame-decoder"

const encodeClientMessage = Schema.encodeSync(Schema.fromJsonString(ClientMessage))
type Mutable<T> = { -readonly [P in keyof T]: T[P] }
type CreateThreadCommand = Mutable<Extract<ClientMessage["command"], { readonly _tag: "CreateThread" }>>
type SubmitPromptCommand = Mutable<Extract<ClientMessage["command"], { readonly _tag: "SubmitPrompt" }>>

const failure = (kind: HostedError["kind"], message: string) => HostedError.make({ kind, message })

const rejection = (payload: Extract<ServerFrameValue["payload"], { readonly _tag: "CommandRejected" }>) => {
  let kind: HostedError["kind"] = "protocol"
  if (payload.reason === "forbidden") kind = "denied"
  if (payload.message === protocolMismatchMessage) kind = "protocol"
  else if (payload.reason === "unavailable") kind = "network"
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
    .runString((value) => decodeThreadFrame(value).pipe(Effect.flatMap((frame) => Queue.offer(frames, frame))), {
      onOpen: Deferred.succeed(opened, undefined).pipe(Effect.asVoid),
    })
    .pipe(
      Effect.catch((error) =>
        Deferred.fail(
          disconnected,
          Schema.is(HostedError)(error) ? error : failure("network", "Thread connection was interrupted"),
        ).pipe(Effect.asVoid),
      ),
      Effect.ensuring(Deferred.fail(disconnected, failure("network", "Thread connection closed")).pipe(Effect.ignore)),
      Effect.forkScoped,
    )

  yield* whileConnected(Deferred.await(opened))

  const send = (message: ClientMessage) =>
    Effect.try({
      try: () => encodeClientMessage(message),
      catch: () => failure("protocol", "Thread command could not be encoded"),
    }).pipe(
      Effect.flatMap(writer),
      Effect.mapError((error) =>
        Schema.is(HostedError)(error) ? error : failure("network", "Thread command could not be sent"),
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

type Connection = Effect.Success<ReturnType<typeof connect>>
type ThreadEventPayload = Extract<ServerFrameValue["payload"], { readonly _tag: "ThreadEvent" }>

const awaitCommand = Effect.fn("HostedThreadClient.awaitCommand")(function* (
  connection: Connection,
  requestId: string,
  commandId: string,
  threadId?: string,
  held?: Array<ThreadEventPayload>,
) {
  while (true) {
    const payload = (yield* connection.next).payload
    if (payload._tag === "ThreadEvent") held?.push(payload)
    if (
      (payload._tag === "CommandAdmitted" ||
        payload._tag === "CommandAccepted" ||
        payload._tag === "CommandRejected") &&
      payload.requestId === requestId
    ) {
      if (payload.commandId === undefined || String(payload.commandId) !== commandId)
        return yield* failure("protocol", "Thread response command identity did not match its command")
      if (threadId !== undefined && String(payload.threadId) !== threadId)
        return yield* failure("protocol", "Thread response identity did not match its command")
      if (payload._tag === "CommandRejected") return yield* rejection(payload)
      return payload
    }
  }
})

const applyCommand = Effect.fn("HostedThreadClient.applyCommand")(function* (
  connection: Connection,
  message: ClientMessage,
  commandId: string,
  threadId?: string,
  held?: Array<ThreadEventPayload>,
) {
  yield* connection.send(message)
  while (true) {
    const outcome = yield* awaitCommand(connection, message.requestId, commandId, threadId, held)
    if (outcome._tag !== "CommandAdmitted") return outcome
  }
})

/**
 * Waits for the Turn admitted by `commandId` to settle. The server names the submission by its command ID, so the
 * Turn is identified from `SubmissionAdmitted`. The hosted stream carries Turn status and transcript units through
 * Thread view snapshots and patches; the result text is the last top-level assistant entry of that Turn. Thread
 * events that arrived while the command acknowledgement was pending are replayed first from `held`.
 */
const awaitTurn = Effect.fn("HostedThreadClient.awaitTurn")(function* (
  connection: Connection,
  threadId: string,
  commandId: string,
  held: ReadonlyArray<ThreadEventPayload>,
) {
  const watch = new TurnWatch(threadId, commandId)
  const nextEvent = (index: number) =>
    index < held.length ? Effect.succeed(held[index]!.event.event) : connection.next.pipe(Effect.map(threadEventOf))
  for (let index = 0; ; index += 1) {
    const event = yield* nextEvent(index)
    if (event === undefined) continue
    const outcome = watch.observe(event)
    if (outcome === undefined) continue
    if (outcome._tag === "Settled") return { turnId: outcome.turnId, text: outcome.text }
    return yield* failure(outcome.kind, outcome.message)
  }
})

type TurnOutcome =
  | { readonly _tag: "Settled"; readonly turnId: string; readonly text: string }
  | { readonly _tag: "Failed"; readonly kind: HostedError["kind"]; readonly message: string }

class TurnWatch {
  private turnId: string | undefined
  private readonly assistantText = new Map<string, string>()

  constructor(
    private readonly threadId: string,
    private readonly commandId: string,
  ) {}

  observe(event: InteractiveEvent): TurnOutcome | undefined {
    if (event._tag === "SubmissionRejected" && event.submissionId === this.commandId)
      return { _tag: "Failed", kind: "protocol", message: event.message }
    if (event._tag === "SubmissionAdmitted" && event.submissionId === this.commandId) {
      if (String(event.threadId) !== this.threadId)
        return { _tag: "Failed", kind: "protocol", message: "Submission admission identity did not match its Thread" }
      this.turnId = String(event.turnId)
      return undefined
    }
    if (this.turnId === undefined) return undefined
    if (event._tag === "ExecutionFailed" && event.turnId !== undefined && String(event.turnId) === this.turnId)
      return { _tag: "Failed", kind: "host", message: event.failure.message }
    if (event._tag === "ThreadViewPatch") {
      this.record(event.patch.upsert, event.patch.remove)
      const change = event.patch.turnChanges.find(
        (candidate) => candidate._tag === "UpsertTurn" && String(candidate.turn.id) === this.turnId,
      )
      return change?._tag === "UpsertTurn" ? this.settle(change.turn.status) : undefined
    }
    if (event._tag === "ThreadViewSnapshot") {
      const entry = event.snapshot.turns.find((candidate) => String(candidate.turn.id) === this.turnId)
      if (entry === undefined) return undefined
      this.assistantText.clear()
      this.record(entry.units)
      return this.settle(entry.turn.status)
    }
    return undefined
  }

  private record(units: ReadonlyArray<TranscriptUnit.Unit>, removed: ReadonlyArray<string> = []) {
    for (const unit of units)
      if (unit.turnId === this.turnId && unit.parentId === undefined && unit.content._tag === "Entry")
        if (unit.content.role === "assistant") this.assistantText.set(unit.key, unit.content.text)
    for (const key of removed) this.assistantText.delete(key)
  }

  private settle(status: string): TurnOutcome | undefined {
    if (status === "completed") return { _tag: "Settled", turnId: this.turnId!, text: lastValue(this.assistantText) }
    if (status === "failed" || status === "cancelled")
      return { _tag: "Failed", kind: "host", message: `Turn ${status}` }
    return undefined
  }
}

const lastValue = (values: ReadonlyMap<string, string>) => {
  let last = ""
  for (const value of values.values()) last = value
  return last
}

const threadEventOf = (frame: ServerFrameValue) =>
  frame.payload._tag === "ThreadEvent" ? frame.payload.event.event : undefined

const attach = Effect.fn("HostedThreadClient.attach")(function* (
  connection: Connection,
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
    if (payload._tag === "CommandRejected" && payload.requestId === requestId) {
      if (String(payload.threadId) !== threadId)
        return yield* failure("protocol", "Thread attachment rejection identity did not match its request")
      return yield* rejection(payload)
    }
    if (payload._tag === "ThreadAttached" && payload.requestId === requestId) {
      if (String(payload.threadId) !== threadId)
        return yield* failure("protocol", "Thread attachment response identity did not match its request")
      return payload
    }
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
            const command: CreateThreadCommand = {
              _tag: "CreateThread",
              commandId: CommandId.make(input.commandId),
              idempotencyKey: IdempotencyKey.make(input.commandId),
              expectedThreadVersion: ThreadVersion.make("0"),
              owner:
                input.owner.kind === "personal"
                  ? { kind: "personal" }
                  : { kind: "organization", organizationId: input.owner.organizationId },
              executorKind: input.executorKind,
            }
            if (input.project !== undefined) command.projectId = ProjectId.make(input.project)
            if (input.runnerTarget !== undefined) command.runnerTarget = input.runnerTarget
            if (input.archiveThreadId !== undefined) command.archiveThreadId = ThreadId.make(input.archiveThreadId)
            if (input.workspaceSeedId !== undefined) command.workspaceSeedId = input.workspaceSeedId
            const accepted = yield* applyCommand(connection, envelope(requestId, command), input.commandId)
            if (accepted.result._tag !== "ThreadCreated")
              return yield* failure("protocol", "Thread creation returned the wrong result")
            if (String(accepted.threadId) !== String(accepted.result.threadId))
              return yield* failure("protocol", "Thread creation returned mismatched identity")
            return HostedThreadId.make(String(accepted.result.threadId))
          }),
        ).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)),
      submit: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const text = input.request.prompt.join("\n").trim()
            if (text.length === 0) return yield* failure("invalid-input", "Prompt must not be empty")
            const connection = yield* connect(input.ticket)
            const snapshot = yield* attach(connection, input.threadId, `${input.commandId}:attach`)
            const requestId = `${input.commandId}:submit`
            const command: SubmitPromptCommand = {
              _tag: "SubmitPrompt",
              threadId: ThreadId.make(input.threadId),
              commandId: CommandId.make(input.commandId),
              idempotencyKey: IdempotencyKey.make(input.commandId),
              expectedThreadVersion: snapshot.threadVersion,
              text,
            }
            if (input.request.mode !== undefined) command.mode = input.request.mode
            if (input.request.review !== undefined) command.review = input.request.review
            const held: Array<ThreadEventPayload> = []
            const accepted = yield* applyCommand(
              connection,
              envelope(requestId, command),
              input.commandId,
              input.threadId,
              held,
            )
            if (accepted.result._tag !== "PromptAdmitted")
              return yield* failure("protocol", "Prompt returned the wrong result")
            const settled = yield* awaitTurn(connection, input.threadId, input.commandId, held)
            return { commandId: input.commandId, status: accepted.result.status, ...settled }
          }),
        ).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)),
      ensureService: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(input.ticket)
            const snapshot = yield* attach(connection, input.threadId, `${input.commandId}:attach`)
            const requestId = `${input.commandId}:service`
            const accepted = yield* applyCommand(
              connection,
              envelope(requestId, {
                _tag: "EnsureRepositoryService",
                threadId: ThreadId.make(input.threadId),
                commandId: CommandId.make(input.commandId),
                idempotencyKey: IdempotencyKey.make(input.commandId),
                expectedThreadVersion: snapshot.threadVersion,
                service: input.service,
              }),
              input.commandId,
              input.threadId,
            )
            if (accepted.result._tag !== "Applied")
              return yield* failure("protocol", "Repository service returned the wrong result")
          }),
        ).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)),
      stopService: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(input.ticket)
            const snapshot = yield* attach(connection, input.threadId, `${input.commandId}:attach`)
            const requestId = `${input.commandId}:service`
            const accepted = yield* applyCommand(
              connection,
              envelope(requestId, {
                _tag: "StopRepositoryService",
                threadId: ThreadId.make(input.threadId),
                commandId: CommandId.make(input.commandId),
                idempotencyKey: IdempotencyKey.make(input.commandId),
                expectedThreadVersion: snapshot.threadVersion,
                serviceId: input.serviceId,
              }),
              input.commandId,
              input.threadId,
            )
            if (accepted.result._tag !== "Applied")
              return yield* failure("protocol", "Repository service returned the wrong result")
          }),
        ).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)),
      openPortal: (input) =>
        Effect.scoped(
          Effect.gen(function* () {
            const connection = yield* connect(input.ticket)
            yield* attach(connection, input.threadId, `${input.requestId}:attach`)
            yield* connection.send(
              envelope(input.requestId, {
                _tag: "OpenPortal",
                threadId: ThreadId.make(input.threadId),
                port: input.port,
              }),
            )
            while (true) {
              const payload = (yield* connection.next).payload
              if (payload._tag === "CommandRejected" && payload.requestId === input.requestId) {
                if (String(payload.threadId) !== input.threadId)
                  return yield* failure("protocol", "Portal rejection identity did not match its request")
                return yield* rejection(payload)
              }
              if (payload._tag === "PortalOpened" && payload.requestId === input.requestId) {
                if (String(payload.threadId) !== input.threadId)
                  return yield* failure("protocol", "Portal response identity did not match its request")
                return payload.url
              }
            }
          }),
        ).pipe(Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor)),
    } satisfies ThreadClientInterface)
  }),
)
