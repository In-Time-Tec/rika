import { Cause, Clock, DateTime, Effect, Exit, Function, Schema } from "effect"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId as ProductTurnId } from "@rika/product/turn-record"
import { HostedClientAuthority } from "@rika/product/hosted-client-authority"
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { ThreadProtocolStore, type ThreadProtocolCommand } from "@rika/product/thread-protocol-store"
import { CreateThreadCommand, MutatingThreadCommand, isDurableThreadEvent } from "@rika/product/client-protocol"
import * as ExecutionProjection from "@rika/product/execution-projection"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { AuthorizationAction } from "@rika/product/hosted-authorization"
import { InteractiveCommand } from "@rika/product/interactive-command"
import { HostedProduct, HostedProductError, type ThreadAuthority } from "../product"
import { HostedThreadApplication, HostedThreadApplicationError } from "./application"
import { HostedWorkspace, HostedWorkspaceError } from "../environment/workspace"

class CommandApplicationError extends Schema.TaggedError<CommandApplicationError>()("CommandApplicationError", {
  kind: Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "unavailable"]),
  message: Schema.String,
}) {}

const DurableThreadCommand = Schema.Union([CreateThreadCommand, MutatingThreadCommand])
const checkpointEquivalent = Schema.toEquivalence(ExecutionProjection.Checkpoint)
type Command = typeof DurableThreadCommand.Type
type InteractiveMutatingCommand = Exclude<
  Command,
  { readonly _tag: "CreateThread" | "SubmitPrompt" | "EnsureRepositoryService" | "StopRepositoryService" }
>
type CommandFailure =
  | CommandApplicationError
  | HostedPersistenceError
  | HostedProductError
  | HostedWorkspaceError
  | HostedThreadApplicationError

const expectedControlAction = (command: Pick<InteractiveMutatingCommand, "_tag">) => {
  if (command._tag === "Approve") return "approve" as const
  if (command._tag === "Deny") return "deny" as const
  return command._tag === "Cancel" ? ("cancel" as const) : undefined
}

const commandControlFailureImpl = (
  command: Pick<InteractiveMutatingCommand, "_tag">,
  events: ReadonlyArray<InteractiveEvent>,
) => {
  const action = expectedControlAction(command)
  return action === undefined
    ? undefined
    : events.find(
        (event): event is Extract<InteractiveEvent, { readonly _tag: "ExecutionControlFailed" }> =>
          event._tag === "ExecutionControlFailed" && event.action === action,
      )
}

export const commandControlFailure: {
  (
    events: ReadonlyArray<InteractiveEvent>,
  ): (command: Pick<InteractiveMutatingCommand, "_tag">) => ReturnType<typeof commandControlFailureImpl>
  (
    command: Pick<InteractiveMutatingCommand, "_tag">,
    events: ReadonlyArray<InteractiveEvent>,
  ): ReturnType<typeof commandControlFailureImpl>
} = Function.dual(2, commandControlFailureImpl)

const persistenceFailure = (error: HostedPersistenceError) => {
  let kind: CommandApplicationError["kind"] = "unavailable"
  if (error.reason === "invalid-authority") kind = "forbidden"
  else if (error.reason === "not-found") kind = "not-found"
  else if (error.reason === "conflict") kind = "conflict"
  return CommandApplicationError.make({ kind, message: error.message })
}

const productFailure = (error: HostedProductError) => {
  const kind =
    error.kind === "invalid" || error.kind === "forbidden" || error.kind === "not-found" || error.kind === "conflict"
      ? error.kind
      : "unavailable"
  return CommandApplicationError.make({ kind, message: error.message })
}

const commandFailure = (error: CommandFailure) => {
  if (Schema.is(CommandApplicationError)(error)) return error
  if (Schema.is(HostedPersistenceError)(error)) return persistenceFailure(error)
  if (Schema.is(HostedProductError)(error)) return productFailure(error)
  if (Schema.is(HostedWorkspaceError)(error))
    return CommandApplicationError.make({
      kind: error.kind === "unsupported" ? "invalid" : "unavailable",
      message: error.message,
    })
  return CommandApplicationError.make({
    kind: "unavailable",
    message: Schema.is(HostedThreadApplicationError)(error) ? error.message : "Thread command application failed",
  })
}

const rejectionEvents = (
  command: Command | undefined,
  error: CommandApplicationError,
): ReadonlyArray<InteractiveEvent> => {
  if (command?._tag === "SubmitPrompt")
    return [
      {
        _tag: "SubmissionRejected",
        threadId: ProductThreadId.make(command.threadId),
        message: error.message,
        submissionId: command.submissionId ?? command.commandId,
      },
    ]
  if (command?._tag !== "Cancel") return []
  const rejected: InteractiveEvent & { readonly _tag: "ExecutionControlFailed"; turnId?: ProductTurnId } = {
    _tag: "ExecutionControlFailed",
    threadId: ProductThreadId.make(command.threadId),
    action: "cancel",
    failure: {
      tag: "HostedThreadCommandRejected",
      category: "operation",
      message: error.message,
      retryable: false,
      retry: "none",
      actor: error.kind === "unavailable" ? "environment" : "user",
    },
  }
  if (command.target._tag === "Turn") Object.assign(rejected, { turnId: ProductTurnId.make(command.target.turnId) })
  return [rejected]
}

const durableCommandPayload = (record: ThreadProtocolCommand) => ({
  ...record.command,
  commandId: record.commandId,
  threadId: record.threadId,
  idempotencyKey: record.idempotencyKey,
  expectedThreadVersion: record.expectedThreadVersion,
})

const authorizationAction = (command: Command): AuthorizationAction => {
  if (command._tag === "SubmitPrompt") return "thread:operate"
  if (command._tag === "EnsureRepositoryService" || command._tag === "StopRepositoryService")
    return "workspace:service:control"
  return "thread:control"
}

const productCommand = (command: InteractiveMutatingCommand) => {
  const value = (() => {
    switch (command._tag) {
      case "EditQueued":
        return { _tag: "EditQueued", turnId: command.turnId, prompt: command.prompt }
      case "Dequeue":
        return { _tag: "Dequeue", turnId: command.turnId }
      case "Steer":
        return { _tag: "Steer", text: command.text, requestId: command.commandId, turnId: command.targetTurnId }
      case "InterruptAndSend":
        return { _tag: "InterruptAndSend", prompt: command.text, targetTurnId: command.targetTurnId }
      case "Cancel":
        return command.target._tag === "Turn" ? { _tag: "Cancel", targetTurnId: command.target.turnId } : undefined
      case "Approve":
        return {
          _tag: "ApproveAuthorization",
          turnId: command.turnId,
          authorizationId: command.authorizationId,
          checkpoint: command.checkpoint,
        }
      case "Deny":
        return {
          _tag: "DenyAuthorization",
          turnId: command.turnId,
          authorizationId: command.authorizationId,
          checkpoint: command.checkpoint,
        }
      case "ArchiveThread":
        return { _tag: "ArchiveThread" }
    }
  })()
  return Schema.decodeUnknownEffect(InteractiveCommand)(value).pipe(
    Effect.mapError(() => CommandApplicationError.make({ kind: "invalid", message: "Interactive command is invalid" })),
  )
}

// A command that keeps failing because its Executor is unavailable is retried on every claim. Without a
// bound the client shows "Sending" forever, so after this long the submission is rejected with the cause.
const defaultAdmissionDeadlineMillis = 5 * 60_000

export const commandApplication = (options: {
  readonly claimMillis: number
  readonly admissionDeadlineMillis?: number
}) =>
  Effect.gen(function* () {
    const admissionDeadlineMillis = options.admissionDeadlineMillis ?? defaultAdmissionDeadlineMillis
    const protocol = yield* ThreadProtocolStore
    const hosted = yield* HostedClientAuthority
    const product = yield* HostedProduct
    const operations = yield* HostedThreadApplication
    const workspace = yield* HostedWorkspace

    const complete = Effect.fn("HostedThreadCommandWorker.complete")(function* (
      record: ThreadProtocolCommand,
      claimToken: string,
      result:
        | { readonly _tag: "Applied" }
        | { readonly _tag: "ThreadCreated"; readonly threadId: string }
        | { readonly _tag: "PromptAdmitted"; readonly status: "accepted" | "queued" }
        | { readonly _tag: "Rejected"; readonly reason: string; readonly message: string },
      events: ReadonlyArray<InteractiveEvent>,
    ) {
      const snapshot = yield* operations.snapshot(record.ownerId, ProductThreadId.make(record.threadId))
      return yield* protocol.completeCommand({
        ownerId: record.ownerId,
        threadId: record.threadId,
        commandId: record.commandId,
        claimToken,
        result,
        events,
        snapshot,
        completedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
      })
    })

    const admitPrompt = Effect.fn("HostedThreadCommandWorker.admitPrompt")(function* (
      record: ThreadProtocolCommand,
      claimToken: string,
      command: Extract<Command, { readonly _tag: "SubmitPrompt" }>,
      authority: ThreadAuthority,
    ) {
      if (record.turnId === undefined)
        return yield* CommandApplicationError.make({ kind: "invalid", message: "Prompt command has no Turn identity" })
      const admission = {
        authority,
        threadId: record.threadId,
        operationKey: command.commandId,
        turnId: record.turnId,
        claimToken,
        submissionId: command.submissionId ?? command.commandId,
        prompt: command.text,
      }
      if (command.attachments !== undefined && command.attachments.length > 0) {
        const images = command.attachments.map((attachment) => {
          const image = { type: "image" as const, mediaType: attachment.mediaType, data: attachment.data }
          if (attachment.filename !== undefined) Object.assign(image, { filename: attachment.filename })
          return image
        })
        Object.assign(admission, { promptParts: [{ type: "text" as const, text: command.text }, ...images] })
      }
      if (command.mode !== undefined) Object.assign(admission, { mode: command.mode })
      return yield* product.admitAuthorizedRun(admission)
    })

    const applyRepositoryService = Effect.fn("HostedThreadCommandWorker.applyRepositoryService")(function* (
      record: ThreadProtocolCommand,
      claimToken: string,
      command: Extract<Command, { readonly _tag: "EnsureRepositoryService" | "StopRepositoryService" }>,
    ) {
      const request =
        command._tag === "EnsureRepositoryService"
          ? { _tag: "RepositoryServiceEnsure" as const, requestId: command.commandId, service: command.service }
          : { _tag: "RepositoryServiceStop" as const, requestId: command.commandId, serviceId: command.serviceId }
      const response = yield* workspace.execute(record.threadId, request)
      if (response._tag === "RepositoryServiceRejected") {
        let kind: CommandApplicationError["kind"] = "unavailable"
        if (response.reason === "conflict") kind = "conflict"
        else if (response.reason === "invalid") kind = "invalid"
        return yield* CommandApplicationError.make({ kind, message: response.message })
      }
      return yield* complete(record, claimToken, { _tag: "Applied" }, [])
    })

    const hasPendingAuthorization = Effect.fn("HostedThreadCommandWorker.hasPendingAuthorization")(function* (
      record: ThreadProtocolCommand,
      command: Extract<Command, { readonly _tag: "Approve" | "Deny" }>,
    ) {
      const snapshot = yield* operations.snapshot(record.ownerId, ProductThreadId.make(record.threadId))
      return snapshot.pendingAuthorizations.some(
        (authorization) =>
          authorization.threadId === record.threadId &&
          authorization.turnId === command.turnId &&
          authorization.authorizationId === command.authorizationId &&
          checkpointEquivalent(authorization.checkpoint, command.checkpoint),
      )
    })

    const resolveCancellation = (
      record: ThreadProtocolCommand,
      claimToken: string,
      command: InteractiveMutatingCommand,
      authority: ThreadAuthority,
    ) => {
      if (command._tag !== "Cancel" || command.target._tag !== "Command") return Effect.succeed(command)
      return product
        .cancelAuthorizedRunAdmission({
          authority,
          threadId: record.threadId,
          cancelCommandId: command.commandId,
          targetCommandId: command.target.commandId,
          claimToken,
        })
        .pipe(
          Effect.map((resolution) =>
            resolution.turnId === undefined
              ? undefined
              : ({
                  ...command,
                  target: { _tag: "Turn" as const, turnId: ProductTurnId.make(resolution.turnId) },
                } as const),
          ),
        )
    }

    const applyInteractive = Effect.fn("HostedThreadCommandWorker.applyInteractive")(function* (
      record: ThreadProtocolCommand,
      claimToken: string,
      command: InteractiveMutatingCommand,
      authority: ThreadAuthority,
    ) {
      if (command._tag === "Approve" || command._tag === "Deny") {
        const pending = yield* hasPendingAuthorization(record, command)
        if (!pending)
          return yield* complete(
            record,
            claimToken,
            { _tag: "Rejected", reason: "conflict", message: "Authorization is no longer pending" },
            [],
          )
      }
      const interactiveCommand = yield* resolveCancellation(record, claimToken, command, authority)
      if (interactiveCommand === undefined)
        return yield* complete(record, claimToken, { _tag: "Applied" }, [
          {
            _tag: "ExecutionControlled",
            threadId: ProductThreadId.make(record.threadId),
            action: "cancelled",
            agentResponseArrived: false,
          },
        ])
      if (record.turnId === undefined)
        return yield* CommandApplicationError.make({
          kind: "invalid",
          message: "Interactive command has no Turn identity",
        })
      return yield* operations.interactive(
        {
          ownerId: record.ownerId,
          threadId: ProductThreadId.make(record.threadId),
          commandId: interactiveCommand.commandId,
          turnId: record.turnId,
          command: yield* productCommand(interactiveCommand),
        },
        (batch) =>
          Effect.gen(function* () {
            if (batch.failure !== undefined)
              return yield* CommandApplicationError.make({ kind: "unavailable", message: batch.failure.message })
            const events = batch.events.filter(isDurableThreadEvent)
            const rejection = commandControlFailure(command, events)
            return yield* protocol.completeCommand({
              ownerId: record.ownerId,
              threadId: record.threadId,
              commandId: record.commandId,
              claimToken,
              result:
                rejection === undefined
                  ? { _tag: "Applied" }
                  : { _tag: "Rejected", reason: "conflict", message: rejection.failure.message },
              events,
              snapshot: batch.snapshot,
              completedAt: DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis)),
            })
          }),
      )
    })

    const apply = Effect.fn("HostedThreadCommandWorker.apply")(function* (
      record: ThreadProtocolCommand,
      claimToken: string,
    ) {
      const command = yield* Schema.decodeUnknownEffect(DurableThreadCommand)(durableCommandPayload(record)).pipe(
        Effect.mapError(() =>
          CommandApplicationError.make({ kind: "invalid", message: "Durable Thread command is invalid" }),
        ),
      )
      yield* hosted.authorizeThread({
        ownerId: record.ownerId,
        threadId: record.threadId,
        actor: record.actor,
        action: authorizationAction(command),
        at: record.admittedAt,
      })
      const authority: ThreadAuthority = { ownerId: record.ownerId, actor: record.actor }
      switch (command._tag) {
        case "CreateThread":
          return yield* complete(record, claimToken, { _tag: "ThreadCreated", threadId: record.threadId }, [])
        case "SubmitPrompt":
          return yield* admitPrompt(record, claimToken, command, authority)
        case "EnsureRepositoryService":
        case "StopRepositoryService":
          return yield* applyRepositoryService(record, claimToken, command)
        default:
          return yield* applyInteractive(record, claimToken, command, authority)
      }
    })

    const renew = (record: ThreadProtocolCommand, claimToken: string): Effect.Effect<never, CommandApplicationError> =>
      Effect.sleep(Math.max(1, Math.floor(options.claimMillis / 4))).pipe(
        Effect.flatMap(() =>
          protocol
            .renewCommandClaim({
              ownerId: record.ownerId,
              threadId: record.threadId,
              commandId: record.commandId,
              claimToken,
              claimMillis: options.claimMillis,
            })
            .pipe(
              Effect.mapError(commandFailure),
              Effect.flatMap((renewed) =>
                renewed
                  ? Effect.void
                  : Effect.fail(
                      CommandApplicationError.make({
                        kind: "unavailable",
                        message: "Thread command application was fenced",
                      }),
                    ),
              ),
            ),
        ),
        Effect.andThen(Effect.suspend(() => renew(record, claimToken))),
      )

    return (record: ThreadProtocolCommand, claimToken: string) => {
      const release = protocol
        .releaseCommandClaim({
          ownerId: record.ownerId,
          threadId: record.threadId,
          commandId: record.commandId,
          claimToken,
        })
        .pipe(Effect.ignore)
      return apply(record, claimToken).pipe(
        Effect.mapError(commandFailure),
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error.kind === "unavailable") {
              const now = yield* Clock.currentTimeMillis
              const pendingMillis = now - DateTime.toEpochMillis(DateTime.makeUnsafe(record.admittedAt))
              if (pendingMillis < admissionDeadlineMillis) return yield* error
              yield* Effect.logWarning("hosted-command.admission-deadline-exceeded").pipe(
                Effect.annotateLogs({
                  "rika.thread.id": record.threadId,
                  "rika.command.id": record.commandId,
                  "rika.duration.millis": pendingMillis,
                  "rika.failure.message": error.message,
                }),
              )
            }
            const payload = durableCommandPayload(record)
            return yield* complete(
              record,
              claimToken,
              { _tag: "Rejected", reason: error.kind, message: error.message },
              rejectionEvents(Schema.is(DurableThreadCommand)(payload) ? payload : undefined, error),
            ).pipe(Effect.mapError(commandFailure))
          }),
        ),
        Effect.raceFirst(renew(record, claimToken)),
        Effect.onExit((exit) => (Exit.isSuccess(exit) || Cause.hasInterrupts(exit.cause) ? release : Effect.void)),
      )
    }
  })
