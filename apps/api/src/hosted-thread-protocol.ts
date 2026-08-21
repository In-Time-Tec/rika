import { Clock, Context, Crypto, DateTime, Effect, Encoding, Layer, Schema } from "effect"
import * as ExecutionProjection from "@rika/product/execution-projection"
import {
  BetterAuthUserId,
  ClientId,
  CommandId,
  DeviceId,
  JsonObject,
  OrganizationId,
  RequestId,
  Sequence,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "@rika/product/hosted-model"
import { StoreError } from "@rika/product/hosted-store"
import { InteractiveCommand } from "@rika/product/interactive-command"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import {
  type ClientMessage,
  type MutatingThreadCommand,
  type ServerFrame,
  isDurableThreadEvent,
  protocolVersion,
} from "@rika/product/client-protocol"
import { ThreadProtocolStore, type ThreadProtocolCommand } from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { HostedOperations, HostedOperationsError } from "./hosted-operations"
import { type AuthenticatedPrincipal, HostedProduct, HostedProductError, type ThreadAuthority } from "./hosted-product"

export const threadWebSocketAudience = "/api/v1/threads/socket"
const ticketLifetimeMillis = 60_000
const zeroCursor = ThreadEventCursor.make("0")
const checkpointEquivalent = Schema.toEquivalence(ExecutionProjection.Checkpoint)

export class HostedThreadProtocolError extends Schema.TaggedError<HostedThreadProtocolError>()(
  "HostedThreadProtocolError",
  {
    kind: Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "stale-version", "unavailable"]),
    message: Schema.String,
  },
) {}

const unavailable = (message = "Hosted Thread protocol is unavailable") =>
  HostedThreadProtocolError.make({ kind: "unavailable", message })
const productFailure = (error: HostedProductError) =>
  HostedThreadProtocolError.make({
    kind:
      error.kind === "forbidden" || error.kind === "not-found" || error.kind === "conflict" || error.kind === "invalid"
        ? error.kind
        : "unavailable",
    message: error.message,
  })
const storeFailure = (error: StoreError) => {
  let kind: HostedThreadProtocolError["kind"] = "unavailable"
  if (error.reason === "invalid-authority") kind = "forbidden"
  else if (error.reason === "not-found" || error.reason === "conflict" || error.reason === "stale-version")
    kind = error.reason
  return HostedThreadProtocolError.make({ kind, message: error.message })
}
const operationFailure = (error: unknown) =>
  unavailable(Schema.is(HostedOperationsError)(error) ? error.message : String(error))
const frame = (payload: ServerFrame["payload"]): ServerFrame => ({ protocolVersion, payload })

const commandResult = (command: ThreadProtocolCommand, requestId: RequestId): ServerFrame["payload"] => {
  if (command.result?._tag === "Rejected") {
    const reason = command.result.reason
    return {
      _tag: "CommandRejected",
      requestId,
      commandId: command.commandId,
      threadId: command.threadId,
      reason:
        reason === "invalid" ||
        reason === "forbidden" ||
        reason === "not-found" ||
        reason === "conflict" ||
        reason === "stale-version"
          ? reason
          : "unavailable",
      currentThreadVersion: command.threadVersion,
      currentCursor: command.cursor ?? zeroCursor,
      message: typeof command.result.message === "string" ? command.result.message : "Command failed",
      details: {},
    }
  }
  return {
    _tag: "CommandAccepted",
    requestId,
    commandId: command.commandId,
    threadId: command.threadId,
    threadVersion: command.threadVersion,
    cursor: command.cursor ?? zeroCursor,
    result:
      command.result?._tag === "ThreadCreated"
        ? { _tag: "ThreadCreated", threadId: ThreadId.make(String(command.result.threadId)) }
        : { _tag: "Applied" },
  }
}

const productCommand = (command: MutatingThreadCommand) => {
  let value: unknown
  switch (command._tag) {
    case "SubmitPrompt":
      value = {
        _tag: "Submit",
        prompt: command.text,
        submissionId: command.commandId,
        ...(command.mode === undefined ? {} : { mode: command.mode }),
        ...(command.attachments === undefined
          ? {}
          : {
              promptParts: command.attachments.map((attachment) => ({
                type: "image",
                mediaType: attachment.mediaType,
                data: attachment.data,
                ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
              })),
            }),
      }
      break
    case "Steer":
      value = {
        _tag: "Steer",
        text: command.text,
        requestId: command.commandId,
        ...(command.targetTurnId === undefined ? {} : { turnId: command.targetTurnId }),
      }
      break
    case "InterruptAndSend":
      value = { _tag: "InterruptAndSend", prompt: command.text }
      break
    case "Cancel":
      value = { _tag: "Cancel" }
      break
    case "Approve":
      value = { _tag: "ApproveAuthorization", turnId: command.turnId, authorizationId: command.authorizationId }
      break
    case "Deny":
      value = { _tag: "DenyAuthorization", turnId: command.turnId, authorizationId: command.authorizationId }
      break
  }
  return Schema.decodeUnknownEffect(InteractiveCommand)(value).pipe(
    Effect.mapError(() =>
      HostedThreadProtocolError.make({ kind: "invalid", message: "Interactive command is invalid" }),
    ),
  )
}

export interface HostedThreadConnection {
  readonly receive: (message: ClientMessage) => Effect.Effect<ReadonlyArray<ServerFrame>, never>
  readonly detach: Effect.Effect<void>
}

export interface HostedThreadProtocolService {
  readonly issueTicket: (principal: AuthenticatedPrincipal) => Effect.Effect<
    {
      readonly ticket: string
      readonly expiresAt: Timestamp
    },
    HostedThreadProtocolError
  >
  readonly connect: (
    ticket: string,
    audience: string,
  ) => Effect.Effect<HostedThreadConnection, HostedThreadProtocolError>
}

export class HostedThreadProtocol extends Context.Service<HostedThreadProtocol, HostedThreadProtocolService>()(
  "@rika/api/hosted-thread-protocol/HostedThreadProtocol",
) {}

export const layer = Layer.effect(
  HostedThreadProtocol,
  Effect.gen(function* () {
    const product = yield* HostedProduct
    const operations = yield* HostedOperations
    const store = yield* ThreadProtocolStore
    const crypto = yield* Crypto.Crypto

    const digest = Effect.fn("HostedThreadProtocol.digest")(function* (ticket: string) {
      const bytes = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(ticket))
        .pipe(Effect.mapError(() => unavailable()))
      return Encoding.encodeHex(bytes)
    })

    const issueTicket: HostedThreadProtocolService["issueTicket"] = Effect.fn("HostedThreadProtocol.issueTicket")(
      function* (principal) {
        yield* product.activatePrincipal(principal).pipe(Effect.mapError(productFailure))
        const issuedAtMillis = yield* Clock.currentTimeMillis
        const issuedAt = DateTime.formatIso(DateTime.makeUnsafe(issuedAtMillis))
        const expiresAt = DateTime.formatIso(DateTime.makeUnsafe(issuedAtMillis + ticketLifetimeMillis))
        const secret = Encoding.encodeBase64Url(
          yield* crypto.randomBytes(32).pipe(Effect.mapError(() => unavailable("Ticket issuance failed"))),
        )
        const ticketId = yield* crypto.randomUUIDv4.pipe(Effect.mapError(() => unavailable("Ticket issuance failed")))
        yield* store
          .issueTicket({
            ticketId,
            ticketDigest: yield* digest(secret),
            userId: BetterAuthUserId.make(principal.userId),
            clientId: ClientId.make(principal.clientId),
            deviceId: DeviceId.make(principal.deviceId),
            audience: threadWebSocketAudience,
            issuedAt,
            expiresAt,
          })
          .pipe(Effect.mapError(storeFailure))
        return { ticket: secret, expiresAt }
      },
    )

    const connect: HostedThreadProtocolService["connect"] = Effect.fn("HostedThreadProtocol.connect")(
      function* (ticket, audience) {
        const connectedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
        const binding = yield* store
          .redeemTicket({ ticketDigest: yield* digest(ticket), audience, redeemedAt: connectedAt })
          .pipe(Effect.mapError(storeFailure))
        const principal: AuthenticatedPrincipal = {
          userId: binding.userId,
          clientId: binding.clientId,
          deviceId: binding.deviceId,
        }
        let attached: { readonly threadId: ThreadId; readonly authority: ThreadAuthority } | undefined

        const reject = Effect.fn("HostedThreadProtocol.reject")(function* (
          message: ClientMessage,
          error: HostedThreadProtocolError,
        ) {
          const commandId =
            "commandId" in message.command ? CommandId.make(String(message.command.commandId)) : undefined
          let current: { readonly threadVersion: ThreadVersion; readonly cursor: ThreadEventCursor } | undefined
          if (attached !== undefined) {
            current = yield* store
              .replay({
                ownerId: attached.authority.ownerId,
                threadId: attached.threadId,
                afterCursor: zeroCursor,
                limit: 1,
              })
              .pipe(
                Effect.map((replay) => ({ threadVersion: replay.threadVersion, cursor: replay.cursor })),
                Effect.orElseSucceed(() => undefined),
              )
          }
          return [
            frame({
              _tag: "CommandRejected",
              requestId: message.requestId,
              ...(commandId === undefined ? {} : { commandId }),
              ...(attached === undefined ? {} : { threadId: attached.threadId }),
              reason: error.kind,
              ...(current === undefined
                ? {}
                : { currentThreadVersion: current.threadVersion, currentCursor: current.cursor }),
              message: error.message,
              details: {},
            }),
          ]
        })

        const receiveUnsafe = Effect.fn("HostedThreadProtocol.receive")(function* (
          message: ClientMessage,
        ): Effect.fn.Return<ReadonlyArray<ServerFrame>, HostedThreadProtocolError> {
          const receivedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
          const command = message.command
          if (command._tag === "CreateThread") {
            const owner =
              command.owner.kind === "personal"
                ? { _tag: "PersonalOwner" as const, userId: binding.userId }
                : {
                    _tag: "OrganizationOwner" as const,
                    organizationId: OrganizationId.make(command.owner.organizationId),
                  }
            const created = yield* product
              .createConnection({
                principal,
                owner,
                ...(command.projectId === undefined ? {} : { projectId: command.projectId }),
                placement: command.placement,
                threadId: command.commandId,
              })
              .pipe(Effect.mapError(productFailure))
            const threadId = ThreadId.make(created.threadId)
            const authority = yield* product.authorizeThread(principal, threadId).pipe(Effect.mapError(productFailure))
            yield* store.initializeThread({ ownerId: authority.ownerId, threadId }).pipe(Effect.mapError(storeFailure))
            const encoded = yield* Schema.encodeEffect(JsonObject)(command).pipe(Effect.mapError(() => unavailable()))
            const admission = yield* store
              .admitCommand({
                ownerId: authority.ownerId,
                threadId,
                commandId: command.commandId,
                idempotencyKey: command.idempotencyKey,
                expectedThreadVersion: command.expectedThreadVersion,
                actor: authority.actor,
                command: encoded,
                admittedAt: receivedAt,
              })
              .pipe(Effect.mapError(storeFailure))
            let completed: ThreadProtocolCommand
            if (admission._tag === "Duplicate") {
              if (admission.command.state !== "completed")
                return yield* HostedThreadProtocolError.make({
                  kind: "conflict",
                  message: "Command is still being applied",
                })
              completed = admission.command
            } else {
              const createdSnapshot = yield* operations
                .snapshot(authority.ownerId, ProductThreadId.make(threadId))
                .pipe(Effect.result)
              completed = yield* store
                .completeCommand({
                  ownerId: authority.ownerId,
                  threadId,
                  commandId: command.commandId,
                  result: { _tag: "ThreadCreated", threadId },
                  events: [],
                  ...(createdSnapshot._tag === "Success" ? { snapshot: createdSnapshot.success } : {}),
                  completedAt: receivedAt,
                })
                .pipe(Effect.mapError(storeFailure))
            }
            attached = { threadId, authority }
            return [frame(commandResult(completed, message.requestId))]
          }

          if (command._tag === "AttachThread") {
            const authority = yield* product
              .authorizeThread(principal, command.threadId)
              .pipe(Effect.mapError(productFailure))
            yield* store
              .initializeThread({ ownerId: authority.ownerId, threadId: command.threadId })
              .pipe(Effect.mapError(storeFailure))
            const replay = yield* store
              .replay({
                ownerId: authority.ownerId,
                threadId: command.threadId,
                afterCursor: command.afterCursor,
                limit: 1_000,
              })
              .pipe(Effect.mapError(storeFailure))
            attached = { threadId: command.threadId, authority }
            const replaySnapshot = replay.snapshot
            const snapshot =
              replaySnapshot?.snapshot ??
              (yield* operations
                .snapshot(authority.ownerId, ProductThreadId.make(command.threadId))
                .pipe(Effect.mapError(operationFailure)))
            return [
              frame({
                _tag: "ThreadSnapshot",
                requestId: message.requestId,
                threadId: command.threadId,
                threadVersion: replaySnapshot?.threadVersion ?? replay.threadVersion,
                cursor: replaySnapshot?.cursor ?? replay.cursor,
                snapshot,
              }),
              ...(replaySnapshot === undefined
                ? []
                : replay.events.map((event) =>
                    frame({
                      _tag: "ThreadEvent",
                      event: {
                        threadId: event.threadId,
                        sequence: Sequence.make(event.sequence),
                        cursor: event.cursor,
                        threadVersion: event.threadVersion,
                        event: event.event,
                        createdAt: event.createdAt,
                      },
                    }),
                  )),
            ]
          }

          if (command._tag === "Detach") {
            attached = undefined
            return []
          }
          if (attached === undefined)
            return yield* HostedThreadProtocolError.make({ kind: "invalid", message: "Attach a Thread first" })
          const authority = yield* product
            .authorizeThread(principal, attached.threadId)
            .pipe(Effect.mapError(productFailure))
          attached = { threadId: attached.threadId, authority }

          if (command._tag === "AcknowledgeCursor") {
            const cursor = yield* store
              .acknowledgeCursor({
                ownerId: authority.ownerId,
                threadId: attached.threadId,
                clientId: binding.clientId,
                cursor: command.cursor,
                acknowledgedAt: receivedAt,
              })
              .pipe(Effect.mapError(storeFailure))
            const replay = yield* store
              .replay({ ownerId: authority.ownerId, threadId: attached.threadId, afterCursor: cursor, limit: 1 })
              .pipe(Effect.mapError(storeFailure))
            return [
              frame({
                _tag: "CommandAccepted",
                requestId: message.requestId,
                threadId: attached.threadId,
                threadVersion: replay.threadVersion,
                cursor: replay.cursor,
                result: { _tag: "Applied" },
              }),
            ]
          }

          const encoded = yield* Schema.encodeEffect(JsonObject)(command).pipe(Effect.mapError(() => unavailable()))
          const admission = yield* store
            .admitCommand({
              ownerId: authority.ownerId,
              threadId: attached.threadId,
              commandId: command.commandId,
              idempotencyKey: command.idempotencyKey,
              expectedThreadVersion: command.expectedThreadVersion,
              actor: authority.actor,
              command: encoded,
              admittedAt: receivedAt,
            })
            .pipe(Effect.mapError(storeFailure))
          if (admission._tag === "Duplicate") {
            if (admission.command.state !== "completed")
              return yield* HostedThreadProtocolError.make({
                kind: "conflict",
                message: "Command is still being applied",
              })
            return [frame(commandResult(admission.command, message.requestId))]
          }

          const applied = yield* Effect.gen(function* () {
            if (command._tag === "Approve" || command._tag === "Deny") {
              const snapshot = yield* operations
                .snapshot(authority.ownerId, ProductThreadId.make(attached!.threadId))
                .pipe(Effect.mapError(operationFailure))
              const pending = snapshot.pendingAuthorizations.find(
                (candidate) =>
                  candidate.threadId === attached!.threadId &&
                  candidate.turnId === command.turnId &&
                  candidate.authorizationId === command.authorizationId &&
                  checkpointEquivalent(candidate.checkpoint, command.checkpoint),
              )
              if (pending === undefined)
                return yield* HostedThreadProtocolError.make({
                  kind: "conflict",
                  message: "Authorization checkpoint is stale or does not belong to this Thread",
                })
            }
            const events = yield* operations
              .interactive({
                ownerId: authority.ownerId,
                threadId: ProductThreadId.make(attached!.threadId),
                commandId: command.commandId,
                command: yield* productCommand(command),
              })
              .pipe(Effect.mapError(operationFailure))
            return { result: { _tag: "Applied" } as const, events: events.filter(isDurableThreadEvent) }
          }).pipe(
            Effect.catch((error) =>
              Effect.succeed({
                result: { _tag: "Rejected" as const, reason: error.kind, message: error.message },
                events: [] as ReadonlyArray<InteractiveEvent>,
              }),
            ),
          )
          const latestSnapshot = yield* operations
            .snapshot(authority.ownerId, ProductThreadId.make(attached.threadId))
            .pipe(Effect.result)
          const completed = yield* store
            .completeCommand({
              ownerId: authority.ownerId,
              threadId: attached.threadId,
              commandId: command.commandId,
              result: applied.result,
              events: applied.events,
              ...(latestSnapshot._tag === "Success" ? { snapshot: latestSnapshot.success } : {}),
              completedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
            })
            .pipe(Effect.mapError(storeFailure))
          return [frame(commandResult(completed, message.requestId))]
        })

        return {
          receive: (message) =>
            receiveUnsafe(message).pipe(
              Effect.catch((error) => reject(message, error)),
              Effect.orDie,
            ),
          detach: Effect.sync(() => (attached = undefined)),
        }
      },
    )

    return HostedThreadProtocol.of({ issueTicket, connect })
  }),
)
