import {
  type ClientCommand,
  type ClientMessage,
  protocolVersion,
  type ServerFrame,
} from "@rika/product/client-protocol"
import { RequestId, ThreadEventCursor, ThreadId } from "@rika/product/hosted-model"
import * as HostedObservability from "@rika/product/hosted-observability"
import { authenticated } from "../account"
import { CredentialStore, HostedError, Http, type Profile } from "../contract"
import { AttachmentProjection, type Attachment } from "./projection"
import { connect } from "../thread-client"
import { Crypto, Deferred, Effect, Exit, Queue } from "effect"

const { failure } = AttachmentProjection

type Payload = ServerFrame["payload"]
type Admitted = Extract<Payload, { readonly _tag: "CommandAdmitted" }>
type Accepted = Extract<Payload, { readonly _tag: "CommandAccepted" }>
export type Rejected = Extract<Payload, { readonly _tag: "CommandRejected" }>
export type CommandOutcome = Admitted | Accepted | Rejected

const isCommandOutcome = (payload: Payload): payload is CommandOutcome =>
  payload._tag === "CommandAdmitted" || payload._tag === "CommandAccepted" || payload._tag === "CommandRejected"

const protocolFailure = (message: string) => HostedError.make({ kind: "protocol", message })
const envelope = (requestId: string, command: ClientCommand): ClientMessage => ({
  protocolVersion,
  requestId: RequestId.make(requestId),
  command,
})

export interface PhysicalConnection {
  readonly command: (
    requestId: string,
    command: ClientCommand,
    completeOnAdmission: boolean,
    onSending?: Effect.Effect<void>,
    onRejected?: (outcome: Rejected) => Effect.Effect<void>,
  ) => Effect.Effect<CommandOutcome, HostedError>
  readonly acknowledge: (requestId: string, threadId: string, cursor: string) => Effect.Effect<void, HostedError>
  readonly attach: (
    threadId: string,
    cursor: string,
    checkpointCursor?: string,
  ) => Effect.Effect<PendingAttachment, HostedError>
  readonly invalidate: Effect.Effect<void>
  readonly detach: Effect.Effect<void, HostedError>
  readonly done: Effect.Effect<never, HostedError>
}

export interface PendingAttachment {
  readonly attachment: Attachment
  readonly complete: Effect.Effect<void>
  readonly fail: (error: HostedError) => Effect.Effect<void>
}

interface AttachmentWaiter {
  readonly response: Deferred.Deferred<Attachment, HostedError>
  readonly processed: Deferred.Deferred<void, HostedError>
}

interface CommandWaiter {
  readonly outcomes: Queue.Queue<CommandOutcome>
  readonly command: ClientCommand
  readonly onRejected: (outcome: Rejected) => Effect.Effect<void>
}

export const physicalConnection = Effect.fn("HostedInteractiveSession.physical")(function* (input: {
  readonly profile: Profile
  readonly threadId: () => string
  readonly cursor: (threadId: string) => string
  readonly checkpointCursor: (threadId: string) => string | undefined
  readonly resolving: () => boolean
  readonly opening: (connection: PhysicalConnection) => Effect.Effect<void>
  readonly receive: (payload: Payload, connection: PhysicalConnection) => Effect.Effect<void, HostedError>
  readonly attached: (attachment: Attachment, connection: PhysicalConnection) => Effect.Effect<void, HostedError>
  readonly processed: (attachment: Attachment, connection: PhysicalConnection) => Effect.Effect<void>
}) {
  const http = yield* Http
  const credentials = yield* CredentialStore
  const crypto = yield* Crypto.Crypto
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(() => failure("Thread request identifier could not be created")),
  )
  const ticket = yield* HostedObservability.observe(
    "connection_ticket",
    {},
    authenticated(input.profile, (session) => http.issueThreadTicket(input.profile.origin, session)).pipe(
      Effect.provideService(Http, http),
      Effect.provideService(CredentialStore, credentials),
    ),
  )
  const socket = yield* HostedObservability.observe("connection_socket", {}, connect(ticket))
  const outcomes = new Map<string, CommandWaiter>()
  const attachments = new Map<string, AttachmentWaiter>()
  const disconnected = yield* Deferred.make<never, HostedError>()
  const failPending = (error: HostedError) =>
    Effect.sync(() => {
      for (const waiter of attachments.values()) {
        Deferred.doneUnsafe(waiter.response, Effect.fail(error))
        Deferred.doneUnsafe(waiter.processed, Effect.fail(error))
      }
      outcomes.clear()
      attachments.clear()
      Deferred.doneUnsafe(disconnected, Effect.fail(error))
    })
  const command = (
    requestId: string,
    value: ClientCommand,
    completeOnAdmission: boolean,
    onSending = Effect.void,
    onRejected: (outcome: Rejected) => Effect.Effect<void> = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      const waiter: CommandWaiter = {
        outcomes: yield* Queue.bounded<CommandOutcome>(2),
        command: value,
        onRejected,
      }
      outcomes.set(requestId, waiter)
      yield* Effect.uninterruptible(
        onSending.pipe(
          Effect.andThen(
            socket
              .send(envelope(requestId, value))
              .pipe(Effect.onError(() => Effect.sync(() => outcomes.delete(requestId)))),
          ),
        ),
      )
      const next = Queue.take(waiter.outcomes).pipe(Effect.raceFirst(Deferred.await(disconnected)))
      let outcome = yield* next
      if (outcome._tag === "CommandAdmitted" && !completeOnAdmission) outcome = yield* next
      return outcome
    }).pipe(Effect.ensuring(Effect.sync(() => outcomes.delete(requestId))))
  const attach = (threadId: string, cursor: string, checkpointCursor?: string) =>
    Effect.gen(function* () {
      const requestId = `attach:${threadId}:${yield* randomId}`
      const waiter = {
        response: yield* Deferred.make<Attachment, HostedError>(),
        processed: yield* Deferred.make<void, HostedError>(),
      }
      attachments.set(requestId, waiter)
      const attachCommand: Extract<ClientCommand, { readonly _tag: "AttachThread" }> = {
        _tag: "AttachThread",
        threadId: ThreadId.make(threadId),
        afterCursor: ThreadEventCursor.make(cursor),
      }
      if (checkpointCursor !== undefined)
        Object.assign(attachCommand, { afterCheckpointCursor: ThreadEventCursor.make(checkpointCursor) })
      yield* socket
        .send(envelope(requestId, attachCommand))
        .pipe(Effect.onError(() => Effect.sync(() => attachments.delete(requestId))))
      const attachment = yield* Deferred.await(waiter.response).pipe(
        Effect.ensuring(Effect.sync(() => attachments.delete(requestId))),
      )
      if (String(attachment.threadId) !== threadId) {
        const error = failure("Thread attachment response identity did not match its request")
        yield* Deferred.fail(waiter.processed, error)
        yield* failPending(error)
        return yield* error
      }
      return {
        attachment,
        complete: Deferred.succeed(waiter.processed, undefined).pipe(Effect.asVoid),
        fail: (error: HostedError) => Deferred.fail(waiter.processed, error).pipe(Effect.asVoid),
      }
    })
  const physical: PhysicalConnection = {
    command,
    acknowledge: (requestId, threadId, cursor) =>
      socket.send(
        envelope(requestId, {
          _tag: "AcknowledgeCursor",
          threadId: ThreadId.make(threadId),
          cursor: ThreadEventCursor.make(cursor),
        }),
      ),
    attach,
    invalidate: failPending(failure("Thread attachment was invalidated")),
    detach: Effect.gen(function* () {
      yield* socket.send(envelope(`detach:${yield* randomId}`, { _tag: "Detach" }))
    }),
    done: Deferred.await(disconnected),
  }
  yield* Effect.gen(function* () {
    while (true) {
      const frame = yield* socket.next
      const payload = frame.payload
      yield* input.receive(payload, physical)
      if (payload._tag === "ThreadAttached") {
        const waiter = attachments.get(payload.requestId)
        if (waiter === undefined) return yield* failure("Thread attachment response was not requested")
        yield* Deferred.succeed(waiter.response, payload)
        yield* Deferred.await(waiter.processed)
      } else if (isCommandOutcome(payload)) {
        const waiter = outcomes.get(payload.requestId)
        if (waiter !== undefined) {
          if ("threadId" in waiter.command && String(payload.threadId) !== String(waiter.command.threadId)) {
            const error = protocolFailure("Thread response identity did not match its command")
            yield* failPending(error)
            return yield* error
          }
          if (
            "commandId" in waiter.command &&
            (payload.commandId === undefined || String(payload.commandId) !== String(waiter.command.commandId))
          ) {
            const error = protocolFailure("Thread response command identity did not match its command")
            yield* failPending(error)
            return yield* error
          }
          if (payload._tag === "CommandRejected") yield* Effect.uninterruptible(waiter.onRejected(payload))
          yield* Queue.offer(waiter.outcomes, payload)
        }
        if (payload._tag === "CommandRejected") {
          const attachmentWaiter = attachments.get(payload.requestId)
          if (attachmentWaiter !== undefined) {
            const error = HostedError.make({ kind: "protocol", message: payload.message })
            yield* Deferred.fail(attachmentWaiter.response, error)
            yield* Deferred.fail(attachmentWaiter.processed, error)
          }
        }
      }
    }
  }).pipe(
    Effect.catch((error) => failPending(error)),
    Effect.ensuring(failPending(failure("Thread connection closed"))),
    Effect.forkScoped,
  )
  yield* input.opening(physical)
  const initialThreadId = input.threadId()
  yield* Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      const attachment = HostedObservability.observe(
        "attach",
        { threadId: initialThreadId },
        Effect.gen(function* () {
          const pending = yield* restore(
            HostedObservability.observe(
              "attach_response",
              { threadId: initialThreadId },
              physical.attach(initialThreadId, input.cursor(initialThreadId), input.checkpointCursor(initialThreadId)),
            ),
          )
          yield* input.attached(pending.attachment, physical).pipe(
            Effect.andThen(
              HostedObservability.observe(
                "attach_ack",
                { threadId: initialThreadId },
                input.processed(pending.attachment, physical),
              ),
            ),
            Effect.andThen(pending.complete),
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? pending
                    .fail(failure("Thread attachment processing did not complete"))
                    .pipe(Effect.andThen(physical.invalidate))
                : Effect.void,
            ),
          )
        }),
      )
      return input.resolving()
        ? HostedObservability.observe("target_resolution", { threadId: initialThreadId }, attachment)
        : attachment
    }),
  )
  return physical
})
