import { Clock, Crypto, DateTime, Effect, Layer, Redacted, Schema } from "effect"
import {
  CommandId,
  JsonObject,
  OrganizationId,
  RequestId,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "@rika/product/hosted-model"
import { HostedPresence } from "@rika/product/hosted-presence"
import * as HostedObservability from "@rika/product/hosted-observability"
import type { AuthorizationAction } from "@rika/product/hosted-authorization"
import { type ClientMessage, ServerFrame, type WorkspacePlacement } from "@rika/product/client-protocol"
import { ThreadProtocolStore, type ThreadProtocolCommand } from "@rika/product/thread-protocol-store"
import { TurnId as ProductTurnId } from "@rika/product/turn-record"
import { HostedThreadApplication } from "./application"
import { HostedProduct, type ThreadAuthority } from "../product"
import { HostedWorkspace } from "../environment/workspace"
import {
  listenForThreadChanges,
  ThreadProtocolNotificationService,
  type ThreadProtocolNotificationGeneration,
  type ThreadProtocolNotifications,
} from "./notifications"
import { HostedPreviewBus, type HostedPreviewBusService } from "./previews"
import { protocolConnectionState } from "./protocol-connection"
import {
  commandResult,
  frame,
  HostedThreadProtocol,
  type HostedThreadConnection,
  HostedThreadProtocolError,
  type HostedThreadProtocolService,
  type MutableCommandRejectedPayload,
  productFailure,
  storeFailure,
  unavailable,
  zeroCursor,
} from "./protocol-contract"
import { ticketOperations } from "./protocol-tickets"

export {
  HostedThreadProtocol,
  type HostedThreadConnection,
  HostedThreadProtocolError,
  type HostedThreadProtocolService,
  threadWebSocketAudience,
} from "./protocol-contract"

const replayDistance = (cursor: string, afterCursor: string) => {
  const distance = BigInt(cursor) - BigInt(afterCursor)
  return distance <= 0 ? 0 : Number(distance > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : distance)
}

const authorizationAction = (command: ClientMessage["command"]): AuthorizationAction => {
  if (command._tag === "InspectWorkspaceFile") return "workspace:file:view"
  if (["EnsureRepositoryService", "StopRepositoryService", "OpenPortal"].includes(command._tag))
    return "workspace:service:control"
  if (command._tag === "AcknowledgeCursor") return "thread:view"
  return command._tag === "UpdatePresence" ? "presence:update" : "thread:control"
}

type CreateConnectionInput = Parameters<HostedProduct["Service"]["createConnection"]>[0]
interface MutableCreateConnectionInput {
  principal: CreateConnectionInput["principal"]
  owner: CreateConnectionInput["owner"]
  projectId?: NonNullable<CreateConnectionInput["projectId"]>
  executorKind: CreateConnectionInput["executorKind"]
  runnerTarget?: NonNullable<CreateConnectionInput["runnerTarget"]>
  workspaceSeedId?: NonNullable<CreateConnectionInput["workspaceSeedId"]>
  threadId: NonNullable<CreateConnectionInput["threadId"]>
  archiveThreadId?: NonNullable<CreateConnectionInput["archiveThreadId"]>
}

type OrbWorkspacePlacement = Extract<WorkspacePlacement, { readonly _tag: "OrbWorkspace" }>
const withAdmittedWorkspace = <A extends object>(admitted: A, workspace: OrbWorkspacePlacement | undefined) =>
  workspace === undefined ? admitted : { ...admitted, workspace }

export const layerWithOptions = (
  options: {
    readonly databaseUrl?: Redacted.Redacted<string>
    readonly workspacePlacement?: (
      ownerId: ThreadAuthority["ownerId"],
      threadId: ThreadId,
    ) => Effect.Effect<WorkspacePlacement, HostedThreadProtocolError>
    readonly notifications?: ThreadProtocolNotifications
    readonly previews?: HostedPreviewBusService
    readonly wakeCommand?: Effect.Effect<void>
  } = {},
) =>
  Layer.effect(
    HostedThreadProtocol,
    Effect.gen(function* () {
      const product = yield* HostedProduct
      const operations = yield* HostedThreadApplication
      const workspace = yield* HostedWorkspace
      const store = yield* ThreadProtocolStore
      const presence = yield* HostedPresence
      const crypto = yield* Crypto.Crypto
      const contextualNotifications = yield* ThreadProtocolNotificationService
      const changes = options.notifications ?? contextualNotifications
      const contextualPreviews = yield* HostedPreviewBus
      const previews = options.previews ?? contextualPreviews
      if (options.databaseUrl !== undefined)
        yield* listenForThreadChanges({ databaseUrl: options.databaseUrl, changes }).pipe(Effect.forkScoped)

      const { issueTicket, redeemTicket } = ticketOperations({ product, store, crypto })
      const admittedWorkspace = Effect.fn("HostedThreadProtocol.admittedWorkspace")(function* (
        command: ClientMessage["command"],
        ownerId: ThreadAuthority["ownerId"],
      ) {
        const placement = options.workspacePlacement
        if (command._tag !== "SubmitPrompt" || placement === undefined) return undefined
        const resolved = yield* placement(ownerId, command.threadId)
        return resolved._tag === "OrbWorkspace" ? resolved : undefined
      })

      const connect: HostedThreadProtocolService["connect"] = Effect.fn("HostedThreadProtocol.connect")(
        function* (ticket, audience) {
          const { binding, principal } = yield* redeemTicket(ticket, audience)
          const pendingCommands = new Map<
            string,
            {
              readonly requestId: RequestId
              readonly command: ThreadProtocolCommand
              readonly notificationGeneration: ThreadProtocolNotificationGeneration
            }
          >()
          const connection = protocolConnectionState({
            principal,
            product,
            operations,
            store,
            presence,
            changes,
            previews,
            workspacePlacement: options.workspacePlacement,
          })

          const reject = Effect.fn("HostedThreadProtocol.reject")(function* (
            message: ClientMessage,
            error: HostedThreadProtocolError,
          ) {
            const commandId =
              "commandId" in message.command ? CommandId.make(String(message.command.commandId)) : undefined
            const threadId = "threadId" in message.command ? message.command.threadId : undefined
            let current: { readonly threadVersion: ThreadVersion; readonly cursor: ThreadEventCursor } | undefined
            if (threadId !== undefined) {
              current = yield* product.authorizeThread(principal, threadId, "thread:view").pipe(
                Effect.flatMap((authority) =>
                  store.replay({
                    ownerId: authority.ownerId,
                    threadId,
                    actor: authority.actor,
                    afterCursor: zeroCursor,
                    limit: 1,
                  }),
                ),
                Effect.map((replay) => ({ threadVersion: replay.threadVersion, cursor: replay.cursor })),
                Effect.orElseSucceed(() => undefined),
              )
            }
            const rejection: MutableCommandRejectedPayload = {
              _tag: "CommandRejected",
              requestId: message.requestId,
              reason: error.kind,
              message: error.message,
              details: {},
            }
            if (commandId !== undefined) rejection.commandId = commandId
            if (threadId !== undefined) rejection.threadId = threadId
            if (current !== undefined) {
              rejection.currentThreadVersion = current.threadVersion
              rejection.currentCursor = current.cursor
            }
            return [frame(rejection)]
          })

          const createThread = Effect.fn("HostedThreadProtocol.createThread")(function* (
            message: ClientMessage & {
              readonly command: Extract<ClientMessage["command"], { readonly _tag: "CreateThread" }>
            },
            receivedAt: string,
          ) {
            const command = message.command
            const owner =
              command.owner.kind === "personal"
                ? { _tag: "PersonalOwner" as const, userId: binding.userId }
                : {
                    _tag: "OrganizationOwner" as const,
                    organizationId: OrganizationId.make(command.owner.organizationId),
                  }
            const createInput: MutableCreateConnectionInput = {
              principal,
              owner,
              executorKind: command.executorKind,
              threadId: command.commandId,
            }
            if (command.projectId !== undefined) createInput.projectId = command.projectId
            if (command.runnerTarget !== undefined) createInput.runnerTarget = command.runnerTarget
            if (command.archiveThreadId !== undefined) {
              yield* product
                .authorizeThread(principal, command.archiveThreadId, "thread:control")
                .pipe(Effect.mapError(productFailure))
              createInput.archiveThreadId = command.archiveThreadId
            }
            if (command.workspaceSeedId !== undefined) createInput.workspaceSeedId = command.workspaceSeedId
            const created = yield* product.createConnection(createInput).pipe(Effect.mapError(productFailure))
            const threadId = ThreadId.make(created.threadId)
            const authority = yield* product
              .authorizeThread(principal, threadId, "thread:control")
              .pipe(Effect.mapError(productFailure))
            yield* store
              .initializeThread({ ownerId: authority.ownerId, threadId, actor: authority.actor })
              .pipe(Effect.mapError(storeFailure))
            const encoded = yield* Schema.encodeEffect(JsonObject)(command).pipe(Effect.mapError(() => unavailable()))
            const notificationGeneration = changes.generation(threadId)
            const admission = yield* store
              .admitCommand({
                ownerId: authority.ownerId,
                threadId,
                commandId: command.commandId,
                turnId: ProductTurnId.make(
                  yield* crypto.randomUUIDv4.pipe(
                    Effect.mapError(() => unavailable("Command identity allocation failed")),
                  ),
                ),
                idempotencyKey: command.idempotencyKey,
                expectedThreadVersion: command.expectedThreadVersion,
                actor: authority.actor,
                command: encoded,
                admittedAt: receivedAt,
              })
              .pipe(Effect.mapError(storeFailure), (effect) =>
                HostedObservability.observe("target_resolution", { ownerId: authority.ownerId, threadId }, effect),
              )
            if (admission._tag === "Admitted") yield* options.wakeCommand ?? Effect.void
            if (admission.command.state === "completed")
              return [frame(commandResult(admission.command, message.requestId))]
            pendingCommands.set(String(admission.command.commandId), {
              requestId: message.requestId,
              command: admission.command,
              notificationGeneration,
            })
            return [
              frame({
                _tag: "CommandAdmitted",
                requestId: message.requestId,
                commandId: admission.command.commandId,
                threadId,
                threadVersion: admission.command.threadVersion,
              }),
            ]
          })

          const receiveUnsafe = Effect.fn("HostedThreadProtocol.receive")(function* (
            message: ClientMessage,
          ): Effect.fn.Return<ReadonlyArray<ServerFrame>, HostedThreadProtocolError> {
            const receivedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
            const command = message.command
            if (command._tag === "CreateThread") return yield* createThread({ ...message, command }, receivedAt)

            if (command._tag === "AttachThread") return yield* connection.attach(command, message.requestId, receivedAt)

            if (command._tag === "Detach") return yield* connection.detach(receivedAt)
            const threadId = command.threadId
            const authority = yield* product
              .authorizeThread(principal, threadId, authorizationAction(command))
              .pipe(Effect.mapError(productFailure))

            if (command._tag === "UpdatePresence") {
              const now = Timestamp.make(receivedAt)
              yield* presence
                .upsert({
                  ownerId: authority.ownerId,
                  threadId,
                  actor: authority.actor,
                  status: command.status,
                  now,
                  expiresAt: Timestamp.make(
                    DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(receivedAt), { minutes: 1 })),
                  ),
                })
                .pipe(Effect.mapError(storeFailure))
              const participants = yield* presence
                .list({ ownerId: authority.ownerId, threadId, actor: authority.actor, now })
                .pipe(Effect.mapError(storeFailure))
              return [
                frame({
                  _tag: "PresenceSnapshot",
                  threadId,
                  participants: participants.map(({ actor, status }) => ({ actor, status })),
                }),
              ]
            }

            if (command._tag === "OpenPortal") {
              const url = yield* workspace.portal(threadId, command.port).pipe(
                Effect.mapError((error) =>
                  HostedThreadProtocolError.make({
                    kind: error.kind === "unsupported" ? "invalid" : "unavailable",
                    message: error.message,
                  }),
                ),
              )
              return [
                frame({
                  _tag: "PortalOpened",
                  requestId: message.requestId,
                  threadId,
                  port: command.port,
                  url,
                }),
              ]
            }

            if (command._tag === "InspectWorkspaceFile") {
              const inspection = yield* workspace
                .execute(threadId, {
                  _tag: "WorkspaceFileInspect",
                  requestId: String(message.requestId),
                  path: command.path,
                  maximumBytes: command.maximumBytes,
                })
                .pipe(
                  Effect.mapError((error) =>
                    HostedThreadProtocolError.make({
                      kind: error.kind === "unsupported" ? "invalid" : "unavailable",
                      message: error.message,
                    }),
                  ),
                )
              if (inspection._tag !== "WorkspaceFileContent" && inspection._tag !== "WorkspaceFileRejected")
                return yield* HostedThreadProtocolError.make({
                  kind: "unavailable",
                  message: "Executor returned an invalid file inspection result",
                })
              return [
                frame({
                  _tag: "WorkspaceFileInspected",
                  requestId: message.requestId,
                  threadId,
                  inspection,
                }),
              ]
            }

            if (command._tag === "AcknowledgeCursor") {
              const acknowledged = yield* store
                .acknowledgeCursor({
                  ownerId: authority.ownerId,
                  threadId,
                  actor: authority.actor,
                  cursor: command.cursor,
                  acknowledgedAt: receivedAt,
                })
                .pipe(Effect.mapError(storeFailure))
              const replayCorrelation = { ownerId: authority.ownerId, threadId }
              const replayLag = replayDistance(acknowledged.headCursor, acknowledged.acknowledgedCursor)
              yield* HostedObservability.replayLagObserved(replayCorrelation, replayLag)
              if (replayLag >= HostedObservability.replayLagAlertEvents)
                yield* HostedObservability.health("replay_lag", replayCorrelation, {
                  value: replayLag,
                  threshold: HostedObservability.replayLagAlertEvents,
                })
              return [
                frame({
                  _tag: "CommandAccepted",
                  requestId: message.requestId,
                  threadId,
                  threadVersion: acknowledged.threadVersion,
                  cursor: acknowledged.headCursor,
                  result: { _tag: "Applied" },
                }),
              ]
            }

            const encoded = yield* Schema.encodeEffect(JsonObject)(command).pipe(Effect.mapError(() => unavailable()))
            const notificationGeneration = changes.generation(threadId)
            const promptWorkspace = yield* admittedWorkspace(command, authority.ownerId)
            const admission = yield* store
              .admitCommand({
                ownerId: authority.ownerId,
                threadId,
                commandId: command.commandId,
                turnId: ProductTurnId.make(
                  yield* crypto.randomUUIDv4.pipe(
                    Effect.mapError(() => unavailable("Command identity allocation failed")),
                  ),
                ),
                idempotencyKey: command.idempotencyKey,
                expectedThreadVersion: command.expectedThreadVersion,
                actor: authority.actor,
                command: encoded,
                admittedAt: receivedAt,
              })
              .pipe(Effect.mapError(storeFailure), (effect) =>
                HostedObservability.observe(
                  "target_resolution",
                  {
                    ownerId: authority.ownerId,
                    threadId,
                  },
                  effect,
                ),
              )
            if (admission._tag === "Admitted") yield* options.wakeCommand ?? Effect.void
            if (admission._tag === "Duplicate") {
              if (admission.command.state === "completed")
                return [frame(commandResult(admission.command, message.requestId))]
            }
            pendingCommands.set(String(admission.command.commandId), {
              requestId: message.requestId,
              command: admission.command,
              notificationGeneration,
            })
            const admitted = {
              _tag: "CommandAdmitted" as const,
              requestId: message.requestId,
              commandId: admission.command.commandId,
              threadId,
              threadVersion: admission.command.threadVersion,
            }
            return [frame(withAdmittedWorkspace(admitted, promptWorkspace))]
          })

          const durableReady = Effect.suspend(() => {
            const waits = new Array<Effect.Effect<void>>(connection.ready)
            const waitingThreads = new Set<string>()
            for (const entry of pendingCommands.values()) {
              const threadId = String(entry.command.threadId)
              if (waitingThreads.has(threadId)) continue
              waitingThreads.add(threadId)
              waits.push(changes.wait(entry.command.threadId, entry.notificationGeneration).pipe(Effect.asVoid))
            }
            return waits.slice(1).reduce((left, right) => Effect.raceFirst(left, right), waits[0]!)
          })

          const drainDurable: HostedThreadConnection["outbound"] = Effect.suspend(() =>
            Effect.gen(function* () {
              const commandFrames = new Array<ServerFrame>()
              for (const entry of pendingCommands.values()) {
                const notificationGeneration = changes.generation(entry.command.threadId)
                const admission = {
                  ownerId: entry.command.ownerId,
                  threadId: entry.command.threadId,
                  commandId: entry.command.commandId,
                  idempotencyKey: entry.command.idempotencyKey,
                  expectedThreadVersion: entry.command.expectedThreadVersion,
                  actor: entry.command.actor,
                  command: entry.command.command,
                  admittedAt: entry.command.admittedAt,
                }
                if (entry.command.turnId !== undefined) Object.assign(admission, { turnId: entry.command.turnId })
                const refreshed = yield* store.admitCommand(admission).pipe(Effect.mapError(storeFailure))
                if (refreshed.command.state === "completed") {
                  pendingCommands.delete(String(entry.command.commandId))
                  commandFrames.push(frame(commandResult(refreshed.command, entry.requestId)))
                } else {
                  pendingCommands.set(String(entry.command.commandId), {
                    ...entry,
                    command: refreshed.command,
                    notificationGeneration,
                  })
                }
              }
              return [...commandFrames, ...(yield* connection.drain)]
            }),
          )

          const outbound = connection.outbound(durableReady, drainDurable)

          return {
            receive: (message) =>
              receiveUnsafe(message).pipe(
                Effect.catch((error) => reject(message, error)),
                Effect.orDie,
              ),
            outbound,
            detach: connection.close,
          }
        },
      )

      return HostedThreadProtocol.of({ issueTicket, connect })
    }),
  ).pipe(Layer.provide(ThreadProtocolNotificationService.layer), Layer.provide(HostedPreviewBus.memoryLayer))

export const layer = layerWithOptions()
