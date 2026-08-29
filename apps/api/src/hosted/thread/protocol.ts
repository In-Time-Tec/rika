import { Clock, Context, Crypto, DateTime, Effect, Encoding, Layer, Option, Redacted, Schema } from "effect"
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
import { HostedPersistenceError } from "@rika/product/hosted-persistence-error"
import { HostedPresence } from "@rika/product/hosted-presence"
import * as HostedObservability from "@rika/product/hosted-observability"
import type { AuthorizationAction } from "@rika/product/hosted-authorization"
import {
  type ClientMessage,
  HostedThreadSnapshot,
  ServerFrame,
  type WorkspacePlacement,
  protocolVersion,
} from "@rika/product/client-protocol"
import { ThreadProtocolStore, type ThreadProtocolCommand, type ThreadReplay } from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId as ProductTurnId } from "@rika/product/turn-record"
import { HostedThreadApplication, HostedThreadApplicationError } from "./application"
import { type AuthenticatedPrincipal, HostedProduct, HostedProductError, type ThreadAuthority } from "../product"
import { HostedWorkspace } from "../environment/workspace"
import {
  listenForThreadChanges,
  ThreadProtocolNotificationService,
  type ThreadProtocolNotificationGeneration,
  type ThreadProtocolNotifications,
} from "./notifications"
import { HostedPreviewBus, type HostedPreviewBusService, type HostedPreviewSubscription } from "./previews"

export const threadWebSocketAudience = "/api/v1/threads/socket"
const ticketLifetimeMillis = 60_000
const zeroCursor = ThreadEventCursor.make("0")
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const encodeThreadSnapshotJson = (snapshot: HostedThreadSnapshot) =>
  encodeUnknownJson(Schema.encodeSync(HostedThreadSnapshot)(snapshot))
const maximumAttachmentEvents = 10_000
const maximumAttachmentBytes = 32 * 1024 * 1024
const replayDistance = (cursor: string, afterCursor: string) => {
  const distance = BigInt(cursor) - BigInt(afterCursor)
  return distance <= 0 ? 0 : Number(distance > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : distance)
}

export class HostedThreadProtocolError extends Schema.TaggedError<HostedThreadProtocolError>()(
  "HostedThreadProtocolError",
  {
    kind: Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "stale-version", "unavailable"]),
    message: Schema.String,
  },
) {}

const unavailable = (message = "Thread protocol is unavailable") =>
  HostedThreadProtocolError.make({ kind: "unavailable", message })
const productFailure = (error: HostedProductError) =>
  HostedThreadProtocolError.make({
    kind:
      error.kind === "forbidden" || error.kind === "not-found" || error.kind === "conflict" || error.kind === "invalid"
        ? error.kind
        : "unavailable",
    message: error.message,
  })
const storeFailure = (error: HostedPersistenceError) => {
  let kind: HostedThreadProtocolError["kind"] = "unavailable"
  if (error.reason === "invalid-authority") kind = "forbidden"
  else if (error.reason === "not-found" || error.reason === "conflict" || error.reason === "stale-version")
    kind = error.reason
  return HostedThreadProtocolError.make({ kind, message: error.message })
}
const operationFailure = (error: HostedThreadApplicationError) => unavailable(error.message)
const frame = (payload: ServerFrame["payload"]): ServerFrame => ({ protocolVersion, payload })
type CommandRejectedPayload = Extract<ServerFrame["payload"], { readonly _tag: "CommandRejected" }>
interface MutableCommandRejectedPayload {
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
      message: Option.getOrElse(
        Schema.decodeUnknownOption(Schema.String)(command.result.message),
        () => "Command failed",
      ),
      details: {},
    }
  }
  let result: Extract<ServerFrame["payload"], { readonly _tag: "CommandAccepted" }>["result"] = { _tag: "Applied" }
  if (command.result?._tag === "ThreadCreated")
    result = { _tag: "ThreadCreated", threadId: ThreadId.make(String(command.result.threadId)) }
  if (
    command.result?._tag === "PromptAdmitted" &&
    (command.result.status === "accepted" || command.result.status === "queued")
  )
    result = { _tag: "PromptAdmitted", status: command.result.status }
  return {
    _tag: "CommandAccepted",
    requestId,
    commandId: command.commandId,
    threadId: command.threadId,
    threadVersion: command.threadVersion,
    cursor: command.cursor ?? zeroCursor,
    result,
  }
}

export interface HostedThreadConnection {
  readonly receive: (message: ClientMessage) => Effect.Effect<ReadonlyArray<ServerFrame>, never>
  readonly outbound: Effect.Effect<ReadonlyArray<ServerFrame>, HostedThreadProtocolError>
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
  "@rika/api/hosted/thread/protocol/HostedThreadProtocol",
) {}

export const layerWithOptions = (
  options: {
    readonly databaseUrl?: Redacted.Redacted<string>
    readonly workspacePlacement?: (
      ownerId: ThreadAuthority["ownerId"],
      threadId: ThreadId,
    ) => Effect.Effect<WorkspacePlacement, HostedThreadProtocolError>
    readonly notifications?: ThreadProtocolNotifications
    readonly previews?: HostedPreviewBusService
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
          const pendingCommands = new Map<
            string,
            {
              readonly requestId: RequestId
              readonly command: ThreadProtocolCommand
              readonly notificationGeneration: ThreadProtocolNotificationGeneration
            }
          >()
          let attached:
            | {
                readonly threadId: ThreadId
                readonly authority: ThreadAuthority
                readonly cursor: ThreadEventCursor
                readonly knownHead: ThreadEventCursor
                readonly snapshotFingerprint: string
                readonly notificationGeneration: ThreadProtocolNotificationGeneration
                readonly previewSubscription: HostedPreviewSubscription
              }
            | undefined

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

          const materializeSnapshot = Effect.fn("HostedThreadProtocol.materializeSnapshot")(function* (
            authority: ThreadAuthority,
            threadId: ThreadId,
            afterCursor: ThreadEventCursor,
          ) {
            const readReplay = store
              .replay({
                ownerId: authority.ownerId,
                threadId,
                actor: authority.actor,
                afterCursor,
                limit: 1_000,
              })
              .pipe(Effect.mapError(storeFailure))
            while (true) {
              const currentSnapshot = yield* operations
                .snapshot(authority.ownerId, ProductThreadId.make(threadId))
                .pipe(Effect.mapError(operationFailure))
              const materializedSnapshot =
                options.workspacePlacement === undefined
                  ? currentSnapshot
                  : {
                      ...currentSnapshot,
                      workspace: yield* options.workspacePlacement(authority.ownerId, threadId),
                    }
              let replay = yield* readReplay
              if (
                replay.snapshot !== undefined &&
                replay.snapshot.threadVersion === replay.threadVersion &&
                replay.snapshot.cursor === replay.cursor &&
                encodeThreadSnapshotJson(replay.snapshot.snapshot) === encodeThreadSnapshotJson(materializedSnapshot)
              )
                return replay
              const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
              const saved = yield* store
                .saveSnapshot({
                  ownerId: authority.ownerId,
                  threadId,
                  threadVersion: replay.threadVersion,
                  cursor: replay.cursor,
                  snapshot: materializedSnapshot,
                  createdAt,
                })
                .pipe(Effect.result)
              if (saved._tag === "Success") return yield* readReplay
              if (saved.failure.reason !== "conflict") return yield* storeFailure(saved.failure)
            }
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
            }

            if (command._tag === "AttachThread") {
              const authority = yield* product
                .authorizeThread(principal, command.threadId, "thread:view")
                .pipe(Effect.mapError(productFailure))
              const notificationGeneration = changes.generation(command.threadId)
              yield* store
                .initializeThread({ ownerId: authority.ownerId, threadId: command.threadId, actor: authority.actor })
                .pipe(Effect.mapError(storeFailure))
              const replayCorrelation = { ownerId: authority.ownerId, threadId: command.threadId }
              let replay = yield* materializeSnapshot(authority, command.threadId, command.afterCursor)
              const replayLag = replayDistance(replay.cursor, command.afterCursor)
              yield* HostedObservability.replayLagObserved(replayCorrelation, replayLag)
              if (replayLag >= HostedObservability.replayLagAlertEvents)
                yield* HostedObservability.health("replay_lag", replayCorrelation, {
                  value: replayLag,
                  threshold: HostedObservability.replayLagAlertEvents,
                })
              const replaySnapshot = replay.snapshot
              if (replaySnapshot === undefined) return yield* unavailable("Thread replay has no durable snapshot")
              const replayEvents = [...replay.events]
              const snapshotCursor = replaySnapshot?.cursor ?? zeroCursor
              const snapshotThreadVersion = replaySnapshot?.threadVersion ?? replay.threadVersion
              let representedCursor = replayEvents.at(-1)?.cursor ?? snapshotCursor
              while (BigInt(representedCursor) < BigInt(replay.cursor)) {
                const page = yield* store
                  .replay({
                    ownerId: authority.ownerId,
                    threadId: command.threadId,
                    actor: authority.actor,
                    afterCursor: representedCursor,
                    throughCursor: replay.cursor,
                    includeSnapshot: false,
                    limit: 1_000,
                  })
                  .pipe(Effect.mapError(storeFailure))
                if (page.events.length === 0)
                  return yield* unavailable("Thread replay does not continuously represent its cursor")
                replayEvents.push(...page.events)
                if (replayEvents.length > maximumAttachmentEvents)
                  return yield* unavailable("Thread replay exceeds the attachment event limit")
                representedCursor = page.events.at(-1)!.cursor
              }
              let expectedCursor = BigInt(snapshotCursor) + 1n
              for (const event of replayEvents) {
                if (BigInt(event.cursor) !== expectedCursor)
                  return yield* unavailable(
                    `Thread replay contains cursor ${event.cursor}; expected ${expectedCursor.toString()}`,
                  )
                expectedCursor += 1n
              }
              if (representedCursor !== replay.cursor)
                return yield* unavailable("Thread replay terminal cursor is not represented")
              const representedThreadVersion = replayEvents.at(-1)?.threadVersion ?? snapshotThreadVersion
              const snapshot =
                options.workspacePlacement === undefined
                  ? replaySnapshot.snapshot
                  : {
                      ...replaySnapshot.snapshot,
                      workspace: yield* options.workspacePlacement(authority.ownerId, command.threadId),
                    }
              const presenceNow = Timestamp.make(receivedAt)
              const presenceExpiresAt = Timestamp.make(
                DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(receivedAt), { minutes: 1 })),
              )
              const participants = yield* presence
                .upsert({
                  ownerId: authority.ownerId,
                  threadId: command.threadId,
                  actor: authority.actor,
                  status: "viewing",
                  now: presenceNow,
                  expiresAt: presenceExpiresAt,
                })
                .pipe(
                  Effect.andThen(
                    presence.list({
                      ownerId: authority.ownerId,
                      threadId: command.threadId,
                      actor: authority.actor,
                      now: presenceNow,
                    }),
                  ),
                  Effect.orElseSucceed(() => []),
                )
              const attachment = frame({
                _tag: "ThreadAttached",
                requestId: message.requestId,
                threadId: command.threadId,
                snapshotThreadVersion,
                snapshotCursor,
                threadVersion: representedThreadVersion,
                cursor: representedCursor,
                snapshot,
                events: replayEvents.map((event) => ({
                  threadId: event.threadId,
                  sequence: Sequence.make(event.sequence),
                  cursor: event.cursor,
                  threadVersion: event.threadVersion,
                  event: event.event,
                  createdAt: event.createdAt,
                })),
                participants: participants.map(({ actor, status }) => ({ actor, status })),
              })
              const encodedAttachment = encodeUnknownJson(attachment)
              if (new TextEncoder().encode(encodedAttachment).byteLength > maximumAttachmentBytes)
                return yield* unavailable("Thread replay exceeds the attachment byte limit")
              const previewSubscription = yield* previews.subscribe(command.threadId)
              if (attached !== undefined) yield* attached.previewSubscription.close
              attached = {
                threadId: command.threadId,
                authority,
                cursor: representedCursor,
                knownHead: representedCursor,
                snapshotFingerprint: encodeThreadSnapshotJson(snapshot),
                notificationGeneration,
                previewSubscription,
              }
              return [attachment]
            }

            if (command._tag === "Detach") {
              if (attached !== undefined) {
                const now = Timestamp.make(receivedAt)
                yield* presence
                  .upsert({
                    ownerId: attached.authority.ownerId,
                    threadId: attached.threadId,
                    actor: attached.authority.actor,
                    status: "away",
                    now,
                    expiresAt: now,
                  })
                  .pipe(Effect.ignore)
                yield* attached.previewSubscription.close
              }
              attached = undefined
              return []
            }
            const threadId = command.threadId
            let requiredAction: AuthorizationAction = "thread:control"
            if (command._tag === "InspectWorkspaceFile") requiredAction = "workspace:file:view"
            if (
              command._tag === "EnsureRepositoryService" ||
              command._tag === "StopRepositoryService" ||
              command._tag === "OpenPortal"
            )
              requiredAction = "workspace:service:control"
            if (command._tag === "AcknowledgeCursor") requiredAction = "thread:view"
            if (command._tag === "UpdatePresence") requiredAction = "presence:update"
            const authority = yield* product
              .authorizeThread(principal, threadId, requiredAction)
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
              const cursor = yield* store
                .acknowledgeCursor({
                  ownerId: authority.ownerId,
                  threadId,
                  actor: authority.actor,
                  cursor: command.cursor,
                  acknowledgedAt: receivedAt,
                })
                .pipe(Effect.mapError(storeFailure))
              const replayCorrelation = { ownerId: authority.ownerId, threadId }
              const replay = yield* HostedObservability.observe(
                "attach",
                replayCorrelation,
                Effect.gen(function* () {
                  const result = yield* store
                    .replay({
                      ownerId: authority.ownerId,
                      threadId,
                      actor: authority.actor,
                      afterCursor: cursor,
                      limit: 1,
                    })
                    .pipe(Effect.mapError(storeFailure))
                  const replayLag = replayDistance(result.cursor, cursor)
                  yield* HostedObservability.replayLagObserved(replayCorrelation, replayLag)
                  if (replayLag >= HostedObservability.replayLagAlertEvents)
                    yield* HostedObservability.health("replay_lag", replayCorrelation, {
                      value: replayLag,
                      threshold: HostedObservability.replayLagAlertEvents,
                    })
                  return result
                }),
              )
              return [
                frame({
                  _tag: "CommandAccepted",
                  requestId: message.requestId,
                  threadId,
                  threadVersion: replay.threadVersion,
                  cursor: replay.cursor,
                  result: { _tag: "Applied" },
                }),
              ]
            }

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
                HostedObservability.observe(
                  "target_resolution",
                  {
                    ownerId: authority.ownerId,
                    threadId,
                  },
                  effect,
                ),
              )
            if (admission._tag === "Duplicate") {
              if (admission.command.state === "completed")
                return [frame(commandResult(admission.command, message.requestId))]
            }
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

          const durableReady = Effect.suspend(() => {
            const current = attached
            const waits = new Array<Effect.Effect<void>>()
            if (current !== undefined)
              waits.push(
                BigInt(current.cursor) < BigInt(current.knownHead)
                  ? Effect.void
                  : changes.wait(current.threadId, current.notificationGeneration).pipe(Effect.asVoid),
              )
            const waitingThreads = new Set(current === undefined ? [] : [String(current.threadId)])
            for (const entry of pendingCommands.values()) {
              const threadId = String(entry.command.threadId)
              if (waitingThreads.has(threadId)) continue
              waitingThreads.add(threadId)
              waits.push(changes.wait(entry.command.threadId, entry.notificationGeneration).pipe(Effect.asVoid))
            }
            if (waits.length === 0) return Effect.never
            return waits.slice(1).reduce((left, right) => Effect.raceFirst(left, right), waits[0]!)
          })

          const drainDurable: HostedThreadConnection["outbound"] = Effect.suspend(() => {
            const current = attached
            return Effect.gen(function* () {
              const commandFrames = new Array<ServerFrame>()
              for (const entry of [...pendingCommands.values()]) {
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
              if (current === undefined || attached !== current) return commandFrames
              const notificationGeneration = changes.generation(current.threadId)
              yield* materializeSnapshot(current.authority, current.threadId, current.cursor)
              let replay = yield* store
                .replay({
                  ownerId: current.authority.ownerId,
                  threadId: current.threadId,
                  actor: current.authority.actor,
                  afterCursor: current.cursor,
                  includeSnapshot: false,
                  limit: 1_000,
                })
                .pipe(Effect.mapError(storeFailure))
              let expectedCursor = BigInt(current.cursor) + 1n
              let reset = replay.events.length === 0 && BigInt(replay.cursor) > BigInt(current.cursor)
              for (const event of replay.events) {
                if (BigInt(event.cursor) !== expectedCursor) reset = true
                expectedCursor = BigInt(event.cursor) + 1n
              }
              if (reset) {
                replay = yield* store
                  .replay({
                    ownerId: current.authority.ownerId,
                    threadId: current.threadId,
                    actor: current.authority.actor,
                    afterCursor: current.cursor,
                    includeSnapshot: true,
                    limit: 1_000,
                  })
                  .pipe(Effect.mapError(storeFailure))
                if (replay.snapshot === undefined || BigInt(replay.snapshot.cursor) <= BigInt(current.cursor))
                  return yield* unavailable("Thread replay gap has no newer durable snapshot")
                expectedCursor = BigInt(replay.snapshot.cursor) + 1n
                for (const event of replay.events) {
                  if (BigInt(event.cursor) !== expectedCursor)
                    return yield* unavailable("Thread replay remains discontinuous after its durable snapshot")
                  expectedCursor += 1n
                }
              }
              const cursor = replay.events.at(-1)?.cursor ?? replay.snapshot?.cursor ?? current.cursor
              const representedHead = cursor === replay.cursor
              let durable: ThreadReplay | undefined
              if (reset) durable = replay
              else if (representedHead)
                durable = yield* store
                  .replay({
                    ownerId: current.authority.ownerId,
                    threadId: current.threadId,
                    actor: current.authority.actor,
                    afterCursor: cursor,
                    throughCursor: cursor,
                    includeSnapshot: true,
                    limit: 1,
                  })
                  .pipe(Effect.mapError(storeFailure))
              const snapshot = durable?.snapshot
              const projectedSnapshot =
                snapshot === undefined || options.workspacePlacement === undefined
                  ? snapshot?.snapshot
                  : {
                      ...snapshot.snapshot,
                      workspace: yield* options.workspacePlacement(current.authority.ownerId, current.threadId),
                    }
              const snapshotFingerprint =
                projectedSnapshot === undefined
                  ? current.snapshotFingerprint
                  : encodeThreadSnapshotJson(projectedSnapshot)
              if (attached !== current) return commandFrames
              attached = {
                ...current,
                cursor,
                knownHead: replay.cursor,
                snapshotFingerprint,
                notificationGeneration,
                previewSubscription: current.previewSubscription,
              }
              const frames =
                reset && projectedSnapshot !== undefined
                  ? [
                      frame({
                        _tag: "ThreadSnapshot",
                        threadId: current.threadId,
                        threadVersion: snapshot!.threadVersion,
                        cursor: snapshot!.cursor,
                        snapshot: projectedSnapshot,
                      }),
                    ]
                  : []
              frames.push(
                ...replay.events.map((event) =>
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
                ),
              )
              if (!reset && projectedSnapshot !== undefined && snapshotFingerprint !== current.snapshotFingerprint)
                frames.push(
                  frame({
                    _tag: "ThreadSnapshot",
                    threadId: current.threadId,
                    threadVersion: snapshot!.threadVersion,
                    cursor: snapshot!.cursor,
                    snapshot: projectedSnapshot,
                  }),
                )
              return [...commandFrames, ...frames]
            })
          })

          const durableOutbound: HostedThreadConnection["outbound"] = durableReady.pipe(Effect.andThen(drainDurable))

          const outbound: HostedThreadConnection["outbound"] = Effect.suspend(() => {
            const current = attached
            if (current === undefined) return durableOutbound
            return Effect.raceFirst(durableReady.pipe(Effect.as(undefined)), current.previewSubscription.take).pipe(
              Effect.flatMap((delivery) => {
                if (delivery === undefined) return drainDurable
                if (attached !== current) return Effect.succeed([])
                return Effect.succeed([
                  frame(
                    delivery._tag === "Reset"
                      ? { _tag: "ThreadPreviewReset", threadId: current.threadId }
                      : {
                          _tag: "ThreadPreview",
                          threadId: delivery.value.threadId,
                          turnId: delivery.value.turnId,
                          preview: delivery.value.preview,
                        },
                  ),
                ])
              }),
            )
          })

          return {
            receive: (message) =>
              receiveUnsafe(message).pipe(
                Effect.catch((error) => reject(message, error)),
                Effect.orDie,
              ),
            outbound,
            detach: Effect.suspend(() => {
              const current = attached
              attached = undefined
              return current?.previewSubscription.close ?? Effect.void
            }),
          }
        },
      )

      return HostedThreadProtocol.of({ issueTicket, connect })
    }),
  ).pipe(Layer.provide(ThreadProtocolNotificationService.layer), Layer.provide(HostedPreviewBus.memoryLayer))

export const layer = layerWithOptions()
