import {
  Cause,
  Clock,
  Context,
  Crypto,
  DateTime,
  Effect,
  FiberMap,
  Function,
  Layer,
  Schema,
  SubscriptionRef,
} from "effect"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId as ProductTurnId } from "@rika/product/turn-record"
import { HostedStore, StoreError } from "@rika/product/hosted-store"
import { ThreadProtocolStore, type ThreadProtocolCommand } from "@rika/product/thread-protocol-store"
import { CreateThreadCommand, MutatingThreadCommand, isDurableThreadEvent } from "@rika/product/client-protocol"
import * as ExecutionProjection from "@rika/product/execution-projection"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { AuthorizationAction } from "@rika/product/hosted-authorization"
import { InteractiveCommand } from "@rika/product/interactive-command"
import { HostedProduct, HostedProductError, type ThreadAuthority } from "../product"
import { HostedThreadApplication, HostedThreadApplicationError } from "./application"
import { HostedToolPolicy, HostedToolPolicyError } from "../execution/tool-policy"
import { HostedWorkspace, HostedWorkspaceError } from "../environment/workspace"

export class HostedThreadCommandWorkerError extends Schema.TaggedError<HostedThreadCommandWorkerError>()(
  "HostedThreadCommandWorkerError",
  { message: Schema.String },
) {}

export interface HostedThreadCommandWorkerService {
  readonly ready: Effect.Effect<void, HostedThreadCommandWorkerError>
  readonly status: Effect.Effect<HostedThreadCommandWorkerStatus>
}

export class HostedThreadCommandWorker extends Context.Service<
  HostedThreadCommandWorker,
  HostedThreadCommandWorkerService
>()("@rika/api/hosted/thread/command-worker/HostedThreadCommandWorker") {}

type PollStatus =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Succeeded"; readonly at: number }
  | { readonly _tag: "Failed"; readonly at: number; readonly message: string }

interface WorkerState {
  readonly poll: PollStatus
  readonly lastSuccessfulPollAt: number | undefined
  readonly lastFailure: { readonly at: number; readonly message: string } | undefined
}

export interface HostedThreadCommandWorkerStatus extends WorkerState {
  readonly active: number
  readonly capacity: number
  readonly availableCapacity: number
  readonly pollAgeMillis: number | undefined
  readonly lastSuccessfulPollAgeMillis: number | undefined
  readonly lastFailureAgeMillis: number | undefined
}

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
  | StoreError
  | HostedProductError
  | HostedWorkspaceError
  | HostedToolPolicyError
  | HostedThreadApplicationError

const commandControlFailureImpl = (
  command: Pick<InteractiveMutatingCommand, "_tag">,
  events: ReadonlyArray<InteractiveEvent>,
) => {
  let expectedAction: "approve" | "cancel" | "deny" | undefined
  if (command._tag === "Approve") expectedAction = "approve"
  else if (command._tag === "Deny") expectedAction = "deny"
  else if (command._tag === "Cancel") expectedAction = "cancel"
  return expectedAction === undefined
    ? undefined
    : events.find(
        (event): event is Extract<InteractiveEvent, { readonly _tag: "ExecutionControlFailed" }> =>
          event._tag === "ExecutionControlFailed" && event.action === expectedAction,
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

const age = (now: number, at: number | undefined) => (at === undefined ? undefined : now - at)
const commandFailure = (error: CommandFailure) => {
  if (Schema.is(CommandApplicationError)(error)) return error
  if (Schema.is(StoreError)(error)) {
    let kind: CommandApplicationError["kind"] = "unavailable"
    if (error.reason === "invalid-authority") kind = "forbidden"
    else if (error.reason === "not-found") kind = "not-found"
    else if (error.reason === "conflict") kind = "conflict"
    return CommandApplicationError.make({ kind, message: error.message })
  }
  if (Schema.is(HostedProductError)(error))
    return CommandApplicationError.make({
      kind:
        error.kind === "invalid" ||
        error.kind === "forbidden" ||
        error.kind === "not-found" ||
        error.kind === "conflict"
          ? error.kind
          : "unavailable",
      message: error.message,
    })
  if (Schema.is(HostedWorkspaceError)(error))
    return CommandApplicationError.make({
      kind: error.kind === "unsupported" ? "invalid" : "unavailable",
      message: error.message,
    })
  if (Schema.is(HostedToolPolicyError)(error)) {
    let kind: CommandApplicationError["kind"] = "unavailable"
    if (error.kind === "forbidden") kind = "forbidden"
    else if (error.kind === "conflict") kind = "conflict"
    else if (error.kind === "unknown-tool") kind = "invalid"
    return CommandApplicationError.make({ kind, message: error.message })
  }
  return CommandApplicationError.make({
    kind: "unavailable",
    message: Schema.is(HostedThreadApplicationError)(error) ? error.message : "Thread command application failed",
  })
}

const rejectionEvents = (
  command: Command | undefined,
  error: CommandApplicationError,
): ReadonlyArray<InteractiveEvent> => {
  if (command === undefined) return []
  if (command._tag === "SubmitPrompt")
    return [
      {
        _tag: "SubmissionRejected",
        threadId: ProductThreadId.make(command.threadId),
        message: error.message,
        submissionId: command.submissionId ?? command.commandId,
      },
    ]
  if (command._tag !== "Cancel") return []
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

const repositoryServiceFailureKind = (reason: "conflict" | "invalid" | "missing" | "unavailable") => {
  if (reason === "conflict") return "conflict" as const
  if (reason === "invalid") return "invalid" as const
  return "unavailable" as const
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
    return undefined
  })()
  return Schema.decodeUnknownEffect(InteractiveCommand)(value).pipe(
    Effect.mapError(() => CommandApplicationError.make({ kind: "invalid", message: "Interactive command is invalid" })),
  )
}

export const layer = (options: {
  readonly claimMillis: number
  readonly pollIntervalMillis: number
  readonly concurrency?: number
}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const protocol = yield* ThreadProtocolStore
      const hosted = yield* HostedStore
      const product = yield* HostedProduct
      const operations = yield* HostedThreadApplication
      const workspace = yield* HostedWorkspace
      const toolPolicy = yield* HostedToolPolicy
      const crypto = yield* Crypto.Crypto
      const concurrency = options.concurrency ?? 1
      const active = yield* FiberMap.make<string>()
      const health = yield* SubscriptionRef.make<WorkerState>({
        poll: { _tag: "Starting" },
        lastSuccessfulPollAt: undefined,
        lastFailure: undefined,
      })

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

      const apply = Effect.fn("HostedThreadCommandWorker.apply")(function* (
        record: ThreadProtocolCommand,
        claimToken: string,
      ) {
        const command = yield* Schema.decodeUnknownEffect(DurableThreadCommand)(record.command).pipe(
          Effect.mapError(() =>
            CommandApplicationError.make({ kind: "invalid", message: "Durable Thread command is invalid" }),
          ),
        )
        let action: AuthorizationAction = "thread:control"
        if (command._tag === "SubmitPrompt") action = "thread:operate"
        if (command._tag === "EnsureRepositoryService" || command._tag === "StopRepositoryService")
          action = "workspace:service:control"
        yield* hosted.authorizeThread({
          ownerId: record.ownerId,
          threadId: record.threadId,
          actor: record.actor,
          action,
          at: record.admittedAt,
        })
        const authority: ThreadAuthority = { ownerId: record.ownerId, actor: record.actor }

        if (command._tag === "CreateThread")
          return yield* complete(record, claimToken, { _tag: "ThreadCreated", threadId: record.threadId }, [])

        if (command._tag === "SubmitPrompt") {
          const admission = {
            authority,
            threadId: record.threadId,
            operationKey: command.commandId,
            prompt: command.text,
          }
          if (command.attachments !== undefined && command.attachments.length > 0) {
            const images = command.attachments.map((attachment) => {
              const image = { type: "image" as const, mediaType: attachment.mediaType, data: attachment.data }
              if (attachment.filename !== undefined) Object.assign(image, { filename: attachment.filename })
              return image
            })
            Object.assign(admission, {
              promptParts: [{ type: "text" as const, text: command.text }, ...images],
            })
          }
          if (command.mode !== undefined) Object.assign(admission, { mode: command.mode })
          const admitted = yield* product.admitAuthorizedRun(admission)
          if (admitted._tag === "Cancelled") return yield* complete(record, claimToken, { _tag: "Applied" }, [])
          return yield* complete(record, claimToken, { _tag: "PromptAdmitted", status: admitted.status }, [
            {
              _tag: "SubmissionAdmitted",
              threadId: ProductThreadId.make(record.threadId),
              turnId: ProductTurnId.make(admitted.turnId),
              status: admitted.status === "accepted" ? "active" : "queued",
              submissionId: command.submissionId ?? command.commandId,
            },
          ])
        }

        if (command._tag === "EnsureRepositoryService" || command._tag === "StopRepositoryService") {
          const response = yield* workspace.execute(
            record.threadId,
            command._tag === "EnsureRepositoryService"
              ? {
                  _tag: "RepositoryServiceEnsure",
                  requestId: command.commandId,
                  service: command.service,
                }
              : {
                  _tag: "RepositoryServiceStop",
                  requestId: command.commandId,
                  serviceId: command.serviceId,
                },
          )
          if (response._tag === "RepositoryServiceRejected")
            return yield* CommandApplicationError.make({
              kind: repositoryServiceFailureKind(response.reason),
              message: response.message,
            })
          return yield* complete(record, claimToken, { _tag: "Applied" }, [])
        }

        if (command._tag === "Approve" || command._tag === "Deny") {
          const snapshot = yield* operations.snapshot(record.ownerId, ProductThreadId.make(record.threadId))
          const pending = snapshot.pendingAuthorizations.find(
            (authorization) =>
              authorization.threadId === record.threadId &&
              authorization.turnId === command.turnId &&
              authorization.authorizationId === command.authorizationId &&
              checkpointEquivalent(authorization.checkpoint, command.checkpoint),
          )
          if (pending === undefined)
            return yield* complete(
              record,
              claimToken,
              { _tag: "Rejected", reason: "conflict", message: "Authorization is no longer pending" },
              [],
            )
          yield* toolPolicy.recordDecision({
            ownerId: record.ownerId,
            threadId: record.threadId,
            turnId: command.turnId,
            actor: record.actor,
            authorizationId: command.authorizationId,
            checkpoint: command.checkpoint,
            decision: command._tag === "Approve" ? "approved" : "denied",
          })
        }

        const interactiveCommand =
          command._tag === "Cancel" && command.target._tag === "Command"
            ? yield* product
                .cancelAuthorizedRunAdmission({
                  authority,
                  threadId: record.threadId,
                  cancelCommandId: command.commandId,
                  targetCommandId: command.target.commandId,
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
            : command
        if (interactiveCommand === undefined)
          return yield* complete(record, claimToken, { _tag: "Applied" }, [
            {
              _tag: "ExecutionControlled",
              threadId: ProductThreadId.make(record.threadId),
              action: "cancelled",
              agentResponseArrived: false,
            },
          ])

        return yield* operations.interactive(
          {
            ownerId: record.ownerId,
            threadId: ProductThreadId.make(record.threadId),
            commandId: interactiveCommand.commandId,
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

      const execute = (record: ThreadProtocolCommand, claimToken: string) => {
        const release = protocol
          .releaseCommandClaim({
            ownerId: record.ownerId,
            threadId: record.threadId,
            commandId: record.commandId,
            claimToken,
          })
          .pipe(Effect.ignore)
        const renew = (): Effect.Effect<never, CommandApplicationError> =>
          Effect.sleep(Math.max(1, Math.floor(options.claimMillis / 4))).pipe(
            Effect.flatMap(() =>
              Effect.gen(function* () {
                const renewed = yield* protocol
                  .renewCommandClaim({
                    ownerId: record.ownerId,
                    threadId: record.threadId,
                    commandId: record.commandId,
                    claimToken,
                    claimMillis: options.claimMillis,
                  })
                  .pipe(Effect.mapError(commandFailure))
                if (!renewed)
                  return yield* CommandApplicationError.make({
                    kind: "unavailable",
                    message: "Thread command application was fenced",
                  })
              }),
            ),
            Effect.andThen(Effect.suspend(renew)),
          )
        return apply(record, claimToken).pipe(
          Effect.mapError(commandFailure),
          Effect.catch((error) => {
            if (error.kind === "unavailable") return Effect.fail(error)
            return complete(
              record,
              claimToken,
              { _tag: "Rejected", reason: error.kind, message: error.message },
              rejectionEvents(Schema.is(DurableThreadCommand)(record.command) ? record.command : undefined, error),
            ).pipe(Effect.mapError(commandFailure))
          }),
          Effect.raceFirst(renew()),
          Effect.ensuring(release),
        )
      }

      const poll = Effect.gen(function* () {
        if ((yield* FiberMap.size(active)) >= concurrency) {
          const succeededAt = yield* Clock.currentTimeMillis
          yield* SubscriptionRef.update(health, (state) => ({
            ...state,
            poll: { _tag: "Succeeded", at: succeededAt } as const,
            lastSuccessfulPollAt: succeededAt,
          }))
          yield* Effect.sleep(options.pollIntervalMillis)
          return
        }
        const claimToken = yield* crypto.randomUUIDv4
        const command = yield* protocol.claimNextCommand({
          claimToken,
          claimMillis: options.claimMillis,
        })
        if (command !== undefined)
          yield* FiberMap.run(
            active,
            `${command.threadId}:${command.commandId}`,
            execute(command, claimToken).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
                return Clock.currentTimeMillis.pipe(
                  Effect.flatMap((at) =>
                    SubscriptionRef.update(health, (state) => ({
                      ...state,
                      lastFailure: { at, message: "Thread command application failed" },
                    })),
                  ),
                  Effect.andThen(Effect.logError("hosted-thread-command-worker.failed")),
                )
              }),
            ),
          )
        const succeededAt = yield* Clock.currentTimeMillis
        yield* SubscriptionRef.update(health, (state) => ({
          ...state,
          poll: { _tag: "Succeeded", at: succeededAt } as const,
          lastSuccessfulPollAt: succeededAt,
        }))
        if (command === undefined) yield* Effect.sleep(options.pollIntervalMillis)
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((at) =>
              SubscriptionRef.update(health, (state) => ({
                ...state,
                poll: { _tag: "Failed", at, message: "Thread command worker poll failed" } as const,
                lastFailure: { at, message: "Thread command worker poll failed" },
              })),
            ),
            Effect.andThen(Effect.logError("hosted-thread-command-worker.poll-failed")),
            Effect.andThen(Effect.sleep(options.pollIntervalMillis)),
          )
        }),
      )

      const status: Effect.Effect<HostedThreadCommandWorkerStatus> = Effect.gen(function* () {
        const state = yield* SubscriptionRef.get(health)
        const now = yield* Clock.currentTimeMillis
        const activeCount = yield* FiberMap.size(active)
        const pollAt = state.poll._tag === "Starting" ? undefined : state.poll.at
        return {
          ...state,
          active: activeCount,
          capacity: concurrency,
          availableCapacity: Math.max(0, concurrency - activeCount),
          pollAgeMillis: age(now, pollAt),
          lastSuccessfulPollAgeMillis: age(now, state.lastSuccessfulPollAt),
          lastFailureAgeMillis: age(now, state.lastFailure?.at),
        }
      })
      const service = HostedThreadCommandWorker.of({
        status,
        ready: status.pipe(
          Effect.flatMap((state) => {
            if (state.poll._tag === "Starting")
              return Effect.fail(HostedThreadCommandWorkerError.make({ message: "Command worker has not polled" }))
            if (state.poll._tag === "Failed")
              return Effect.fail(HostedThreadCommandWorkerError.make({ message: state.poll.message }))
            if (state.pollAgeMillis !== undefined && state.pollAgeMillis > options.pollIntervalMillis * 4)
              return Effect.fail(HostedThreadCommandWorkerError.make({ message: "Command worker poll is stale" }))
            return Effect.void
          }),
        ),
      })
      return Layer.merge(
        Layer.succeed(HostedThreadCommandWorker, service),
        Layer.effectDiscard(Effect.forkScoped(Effect.forever(poll))),
      )
    }),
  )
