import { Context, Effect, Function, Option, Schema } from "effect"
import { RequestId, ThreadEventCursor, ThreadId, Timestamp } from "@rika/product/hosted-model"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { type ClientMessage, ServerFrame, protocolVersion } from "@rika/product/client-protocol"
import type { ThreadProtocolCommand } from "@rika/product/thread-protocol-store"
import { HostedThreadApplicationError } from "./application"
import { type AuthenticatedPrincipal, HostedProductError } from "../product"

export const threadWebSocketAudience = "/api/v1/threads/socket"
export const zeroCursor = ThreadEventCursor.make("0")

export class HostedThreadProtocolError extends Schema.TaggedError<HostedThreadProtocolError>()(
  "HostedThreadProtocolError",
  {
    kind: Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "stale-version", "unavailable"]),
    message: Schema.String,
  },
) {}

export const unavailable = (message = "Thread protocol is unavailable") =>
  HostedThreadProtocolError.make({ kind: "unavailable", message })

export const productFailure = (error: HostedProductError) =>
  HostedThreadProtocolError.make({
    kind:
      error.kind === "forbidden" || error.kind === "not-found" || error.kind === "conflict" || error.kind === "invalid"
        ? error.kind
        : "unavailable",
    message: error.message,
  })

export const storeFailure = (error: HostedPersistenceError) => {
  let kind: HostedThreadProtocolError["kind"] = "unavailable"
  if (error.reason === "invalid-authority") kind = "forbidden"
  else if (error.reason === "not-found" || error.reason === "conflict" || error.reason === "stale-version")
    kind = error.reason
  return HostedThreadProtocolError.make({ kind, message: error.message })
}

export const operationFailure = (error: HostedThreadApplicationError) => unavailable(error.message)

export const frame = (payload: ServerFrame["payload"]): ServerFrame => ({ protocolVersion, payload })

export type CommandRejectedPayload = Extract<ServerFrame["payload"], { readonly _tag: "CommandRejected" }>

export interface MutableCommandRejectedPayload {
  _tag: CommandRejectedPayload["_tag"]
  requestId: CommandRejectedPayload["requestId"]
  commandId?: NonNullable<CommandRejectedPayload["commandId"]>
  threadId?: NonNullable<CommandRejectedPayload["threadId"]>
  reason: CommandRejectedPayload["reason"]
  currentThreadVersion?: NonNullable<CommandRejectedPayload["currentThreadVersion"]>
  currentCursor?: NonNullable<CommandRejectedPayload["currentCursor"]>
  message: CommandRejectedPayload["message"]
  details: CommandRejectedPayload["details"]
}

const decodeRejectionReason = Schema.decodeUnknownOption(
  Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "stale-version"]),
)

const acceptedResult = (
  result: ThreadProtocolCommand["result"],
): Extract<ServerFrame["payload"], { readonly _tag: "CommandAccepted" }>["result"] => {
  if (result?._tag === "ThreadCreated")
    return { _tag: "ThreadCreated", threadId: ThreadId.make(String(result.threadId)) }
  if (result?._tag === "PromptAdmitted" && (result.status === "accepted" || result.status === "queued"))
    return { _tag: "PromptAdmitted", status: result.status }
  return { _tag: "Applied" }
}

export const commandResult: {
  (requestId: RequestId): (command: ThreadProtocolCommand) => ServerFrame["payload"]
  (command: ThreadProtocolCommand, requestId: RequestId): ServerFrame["payload"]
} = Function.dual(2, (command: ThreadProtocolCommand, requestId: RequestId): ServerFrame["payload"] => {
  if (command.result?._tag === "Rejected") {
    return {
      _tag: "CommandRejected",
      requestId,
      commandId: command.commandId,
      threadId: command.threadId,
      reason: Option.getOrElse(decodeRejectionReason(command.result.reason), () => "unavailable"),
      currentThreadVersion: command.threadVersion,
      currentCursor: command.cursor ?? zeroCursor,
      message: Option.getOrElse(
        Schema.decodeUnknownOption(Schema.String)(command.result.message),
        () => "Command failed",
      ),
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
    result: acceptedResult(command.result),
  }
})

export interface HostedThreadConnection {
  readonly receive: (message: ClientMessage) => Effect.Effect<ReadonlyArray<ServerFrame>, never>
  readonly outbound: Effect.Effect<ReadonlyArray<ServerFrame>, HostedThreadProtocolError>
  readonly detach: Effect.Effect<void>
}

export interface HostedThreadProtocolService {
  readonly issueTicket: (
    principal: AuthenticatedPrincipal,
  ) => Effect.Effect<{ readonly ticket: string; readonly expiresAt: Timestamp }, HostedThreadProtocolError>
  readonly connect: (
    ticket: string,
    audience: string,
  ) => Effect.Effect<HostedThreadConnection, HostedThreadProtocolError>
}

export class HostedThreadProtocol extends Context.Service<HostedThreadProtocol, HostedThreadProtocolService>()(
  "@rika/api/hosted/thread/protocol-contract/HostedThreadProtocol",
) {}
