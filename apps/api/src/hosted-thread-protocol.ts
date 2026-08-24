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
import { HostedStore, StoreError } from "@rika/product/hosted-store"
import * as HostedObservability from "@rika/product/hosted-observability"
import { InteractiveCommand } from "@rika/product/interactive-command"
import type { InteractiveEvent } from "@rika/product/interactive-event"
import type { AuthorizationAction } from "@rika/product/hosted-authorization"
import {
  type ClientMessage,
  type MutatingThreadCommand,
  ServerFrame,
  isDurableThreadEvent,
  protocolVersion,
} from "@rika/product/client-protocol"
import { ThreadProtocolStore, type ThreadProtocolCommand } from "@rika/product/thread-protocol-store"
import { ThreadId as ProductThreadId } from "@rika/product/thread-record"
import { TurnId as ProductTurnId } from "@rika/product/turn-record"
import { HostedThreadApplication, HostedThreadApplicationError } from "./hosted-thread-application"
import { type AuthenticatedPrincipal, HostedProduct, HostedProductError, type ThreadAuthority } from "./hosted-product"
import { HostedToolPolicy } from "./hosted-tool-policy"
import { HostedWorkspace } from "./hosted-workspace"

export const threadWebSocketAudience = "/api/v1/threads/socket"
const ticketLifetimeMillis = 60_000
const zeroCursor = ThreadEventCursor.make("0")
const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const maximumAttachmentEvents = 10_000
const maximumAttachmentBytes = 32 * 1024 * 1024
const checkpointEquivalent = Schema.toEquivalence(ExecutionProjection.Checkpoint)
const replayDistance = (cursor: string, afterCursor: string) => {
  const distance = BigInt(cursor) - BigInt(afterCursor)
  return distance <= 0 ? 0 : Number(distance > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : distance)
}

const repositoryServiceFailureKind = (
  reason: "conflict" | "invalid" | "missing" | "unavailable",
): "conflict" | "invalid" | "unavailable" => {
  if (reason === "conflict") return "conflict"
  if (reason === "invalid") return "invalid"
  return "unavailable"
}

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
  unavailable(Schema.is(HostedThreadApplicationError)(error) ? error.message : String(error))
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

type InteractiveMutatingCommand = Exclude<
  MutatingThreadCommand,
  { readonly _tag: "SubmitPrompt" | "EnsureRepositoryService" | "StopRepositoryService" }
>

const productCommand = (command: InteractiveMutatingCommand) => {
  let value: unknown
  switch (command._tag) {
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
      value = {
        _tag: "ApproveAuthorization",
        turnId: command.turnId,
        authorizationId: command.authorizationId,
        checkpoint: command.checkpoint,
      }
      break
    case "Deny":
      value = {
        _tag: "DenyAuthorization",
        turnId: command.turnId,
        authorizationId: command.authorizationId,
        checkpoint: command.checkpoint,
      }
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
  readonly active: Effect.Effect<boolean>
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
    const operations = yield* HostedThreadApplication
    const workspace = yield* HostedWorkspace
    const store = yield* ThreadProtocolStore
    const hosted = yield* HostedStore
    const toolPolicy = yield* HostedToolPolicy
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
          return [
            frame({
              _tag: "CommandRejected",
              requestId: message.requestId,
              ...(commandId === undefined ? {} : { commandId }),
              ...(threadId === undefined ? {} : { threadId }),
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
                executorKind: command.executorKind,
                ...(command.runnerTarget === undefined ? {} : { runnerTarget: command.runnerTarget }),
                threadId: command.commandId,
              })
              .pipe(Effect.mapError(productFailure))
            const threadId = ThreadId.make(created.threadId)
            const authority = yield* product
              .authorizeThread(principal, threadId, "thread:control")
              .pipe(Effect.mapError(productFailure))
            yield* store
              .initializeThread({ ownerId: authority.ownerId, threadId, actor: authority.actor })
              .pipe(Effect.mapError(storeFailure))
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
              .pipe(Effect.mapError(storeFailure), (effect) =>
                HostedObservability.observe("target_resolution", { ownerId: authority.ownerId, threadId }, effect),
              )
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
            return [frame(commandResult(completed, message.requestId))]
          }

          if (command._tag === "AttachThread") {
            const authority = yield* product
              .authorizeThread(principal, command.threadId, "thread:view")
              .pipe(Effect.mapError(productFailure))
            yield* store
              .initializeThread({ ownerId: authority.ownerId, threadId: command.threadId, actor: authority.actor })
              .pipe(Effect.mapError(storeFailure))
            const currentSnapshot = yield* operations
              .snapshot(authority.ownerId, ProductThreadId.make(command.threadId))
              .pipe(Effect.mapError(operationFailure))
            const replayCorrelation = { ownerId: authority.ownerId, threadId: command.threadId }
            let replay = yield* HostedObservability.observe(
              "attach",
              replayCorrelation,
              Effect.gen(function* () {
                const result = yield* store
                  .replay({
                    ownerId: authority.ownerId,
                    threadId: command.threadId,
                    actor: authority.actor,
                    afterCursor: command.afterCursor,
                    limit: 1_000,
                  })
                  .pipe(Effect.mapError(storeFailure))
                const replayLag = replayDistance(result.cursor, command.afterCursor)
                yield* HostedObservability.replayLagObserved(replayCorrelation, replayLag)
                if (replayLag >= HostedObservability.replayLagAlertEvents)
                  yield* HostedObservability.health("replay_lag", replayCorrelation, {
                    value: replayLag,
                    threshold: HostedObservability.replayLagAlertEvents,
                  })
                return result
              }),
            )
            if (replay.snapshot === undefined) {
              const createdAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
              const saved = yield* store
                .saveSnapshot({
                  ownerId: authority.ownerId,
                  threadId: command.threadId,
                  threadVersion: replay.threadVersion,
                  cursor: replay.cursor,
                  snapshot: currentSnapshot,
                  createdAt,
                })
                .pipe(Effect.result)
              if (saved._tag === "Failure" && saved.failure.reason !== "conflict")
                return yield* storeFailure(saved.failure)
              replay = yield* store
                .replay({
                  ownerId: authority.ownerId,
                  threadId: command.threadId,
                  actor: authority.actor,
                  afterCursor: command.afterCursor,
                  limit: 1_000,
                })
                .pipe(Effect.mapError(storeFailure))
            }
            const replaySnapshot = replay.snapshot
            if (replaySnapshot === undefined) return yield* unavailable("Hosted Thread replay has no durable snapshot")
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
                return yield* unavailable("Hosted Thread replay does not continuously represent its cursor")
              replayEvents.push(...page.events)
              if (replayEvents.length > maximumAttachmentEvents)
                return yield* unavailable("Hosted Thread replay exceeds the attachment event limit")
              representedCursor = page.events.at(-1)!.cursor
            }
            let expectedCursor = BigInt(snapshotCursor) + 1n
            for (const event of replayEvents) {
              if (BigInt(event.cursor) !== expectedCursor)
                return yield* unavailable(
                  `Hosted Thread replay contains cursor ${event.cursor}; expected ${expectedCursor.toString()}`,
                )
              expectedCursor += 1n
            }
            if (representedCursor !== replay.cursor)
              return yield* unavailable("Hosted Thread replay terminal cursor is not represented")
            const representedThreadVersion = replayEvents.at(-1)?.threadVersion ?? snapshotThreadVersion
            const snapshot = replaySnapshot.snapshot
            const presenceNow = Timestamp.make(receivedAt)
            const presenceExpiresAt = Timestamp.make(
              DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(receivedAt), { minutes: 1 })),
            )
            const participants = yield* hosted
              .upsertPresence({
                ownerId: authority.ownerId,
                threadId: command.threadId,
                actor: authority.actor,
                status: "viewing",
                now: presenceNow,
                expiresAt: presenceExpiresAt,
              })
              .pipe(
                Effect.andThen(
                  hosted.listPresence({
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
              return yield* unavailable("Hosted Thread replay exceeds the attachment byte limit")
            attached = { threadId: command.threadId, authority }
            return [attachment]
          }

          if (command._tag === "Detach") {
            if (attached !== undefined) {
              const now = Timestamp.make(receivedAt)
              yield* hosted
                .upsertPresence({
                  ownerId: attached.authority.ownerId,
                  threadId: attached.threadId,
                  actor: attached.authority.actor,
                  status: "away",
                  now,
                  expiresAt: now,
                })
                .pipe(Effect.ignore)
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
            command._tag === "PauseOrb" ||
            command._tag === "ResumeOrb" ||
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
            yield* hosted
              .upsertPresence({
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
            const participants = yield* hosted
              .listPresence({ ownerId: authority.ownerId, threadId, actor: authority.actor, now })
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
            if (command._tag !== "SubmitPrompt")
              return yield* HostedThreadProtocolError.make({
                kind: "conflict",
                message: "Command is still being applied",
              })
          }

          const applied = yield* Effect.gen(function* () {
            if (command._tag === "SubmitPrompt") {
              const admitted = yield* product
                .admitRun({
                  principal,
                  threadId,
                  operationKey: command.commandId,
                  prompt: command.text,
                  ...(command.attachments === undefined
                    ? {}
                    : {
                        promptParts: command.attachments.map((attachment) => ({
                          type: "image" as const,
                          mediaType: attachment.mediaType,
                          data: attachment.data,
                          ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
                        })),
                      }),
                  ...(command.mode === undefined ? {} : { mode: command.mode }),
                })
                .pipe(Effect.mapError(productFailure))
              return {
                result: { _tag: "PromptAdmitted" as const, status: admitted.status },
                events: [
                  {
                    _tag: "SubmissionAdmitted" as const,
                    threadId: ProductThreadId.make(threadId),
                    turnId: ProductTurnId.make(admitted.turnId),
                    status: admitted.status === "accepted" ? ("active" as const) : ("queued" as const),
                    submissionId: command.commandId,
                  },
                ],
              }
            }
            let authorization:
              | {
                  readonly actor: ThreadAuthority["actor"]
                  readonly turnId: string
                  readonly authorizationId: string
                  readonly checkpoint: ExecutionProjection.Checkpoint
                  readonly operation: string
                  readonly capability: string
                  readonly arguments: string
                  readonly repository: JsonObject | null
                  readonly branch: string | null
                  readonly executor: JsonObject
                  readonly decision: "approve" | "deny"
                }
              | undefined
            if (command._tag === "PauseOrb" || command._tag === "ResumeOrb") {
              yield* (command._tag === "PauseOrb" ? workspace.pause(threadId) : workspace.resume(threadId)).pipe(
                Effect.mapError((error) =>
                  HostedThreadProtocolError.make({
                    kind: error.kind === "unsupported" ? "invalid" : "unavailable",
                    message: error.message,
                  }),
                ),
              )
              return { result: { _tag: "Applied" } as const, events: [] as ReadonlyArray<InteractiveEvent> }
            }
            if (command._tag === "EnsureRepositoryService" || command._tag === "StopRepositoryService") {
              const result = yield* workspace
                .execute(
                  threadId,
                  command._tag === "EnsureRepositoryService"
                    ? { _tag: "RepositoryServiceEnsure", requestId: command.commandId, service: command.service }
                    : { _tag: "RepositoryServiceStop", requestId: command.commandId, serviceId: command.serviceId },
                )
                .pipe(
                  Effect.mapError((error) =>
                    HostedThreadProtocolError.make({
                      kind: error.kind === "unsupported" ? "invalid" : "unavailable",
                      message: error.message,
                    }),
                  ),
                )
              if (result._tag === "RepositoryServiceRejected")
                return yield* HostedThreadProtocolError.make({
                  kind: repositoryServiceFailureKind(result.reason),
                  message: result.message,
                })
              return { result: { _tag: "Applied" } as const, events: [] as ReadonlyArray<InteractiveEvent> }
            }
            if (command._tag === "Approve" || command._tag === "Deny") {
              const snapshot = yield* operations
                .snapshot(authority.ownerId, ProductThreadId.make(threadId))
                .pipe(Effect.mapError(operationFailure))
              const pending = snapshot.pendingAuthorizations.find(
                (candidate) =>
                  candidate.threadId === threadId &&
                  candidate.turnId === command.turnId &&
                  candidate.authorizationId === command.authorizationId &&
                  checkpointEquivalent(candidate.checkpoint, command.checkpoint),
              )
              if (pending === undefined)
                return yield* HostedThreadProtocolError.make({
                  kind: "conflict",
                  message: "Authorization checkpoint is stale or does not belong to this Thread",
                })
              if (pending.operation.startsWith("rika.tool.")) {
                if (pending.inputTruncated)
                  return yield* HostedThreadProtocolError.make({
                    kind: "conflict",
                    message: "Authorization request is not exact",
                  })
                yield* toolPolicy
                  .recordDecision({
                    ownerId: authority.ownerId,
                    threadId,
                    turnId: command.turnId,
                    actor: authority.actor,
                    authorizationId: command.authorizationId,
                    checkpoint: command.checkpoint,
                    operation: pending.operation,
                    capability: pending.capability,
                    authorizationRequest: pending.input,
                    decision: command._tag === "Approve" ? "approved" : "denied",
                    outcome: "admitted",
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      HostedThreadProtocolError.make({
                        kind: error.kind === "conflict" ? "conflict" : "unavailable",
                        message:
                          error.kind === "conflict"
                            ? "Authorization request is not exact"
                            : "Authorization audit is unavailable",
                      }),
                    ),
                  )
              }
              const execution = yield* product
                .threadExecutionContext(authority.ownerId, threadId)
                .pipe(Effect.mapError(productFailure))
              authorization = {
                actor: authority.actor,
                turnId: pending.turnId,
                authorizationId: pending.authorizationId,
                checkpoint: pending.checkpoint,
                operation: pending.operation,
                capability: pending.capability,
                arguments: pending.input,
                repository: execution.repository,
                branch: execution.branch,
                executor: execution.executor,
                decision: command._tag === "Approve" ? "approve" : "deny",
              }
            }
            return yield* operations.interactive(
              {
                ownerId: authority.ownerId,
                threadId: ProductThreadId.make(threadId),
                commandId: command.commandId,
                command: yield* productCommand(command),
              },
              (batch) =>
                Effect.gen(function* () {
                  const events = batch.events
                  let controlFailure: Extract<InteractiveEvent, { readonly _tag: "ExecutionControlFailed" }> | undefined
                  if (command._tag === "Approve" || command._tag === "Deny") {
                    const action = command._tag === "Approve" ? "approve" : "deny"
                    for (const event of events)
                      if (event._tag === "ExecutionControlFailed" && event.action === action) {
                        controlFailure = event
                        break
                      }
                  }
                  let result
                  if (batch.failure !== undefined)
                    result = { _tag: "Rejected" as const, reason: "unavailable", message: batch.failure.message }
                  else if (controlFailure === undefined)
                    result = {
                      _tag: "Applied" as const,
                      ...(authorization === undefined
                        ? {}
                        : { authorization: { ...authorization, result: { _tag: "Delivered" as const } } }),
                    }
                  else
                    result = {
                      _tag: "Rejected" as const,
                      reason: "conflict",
                      message: controlFailure.failure.message,
                      authorization: {
                        ...authorization!,
                        result: { _tag: "Rejected" as const, failure: controlFailure.failure },
                      },
                    }
                  const durableEvents = events.filter(isDurableThreadEvent)
                  const completedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
                  const completed = yield* store.completeCommand({
                    ownerId: authority.ownerId,
                    threadId,
                    commandId: command.commandId,
                    result,
                    events: durableEvents,
                    snapshot: batch.snapshot,
                    completedAt,
                  })
                  return { result, events: durableEvents, completed, completedAt }
                }),
            )
          }).pipe(
            Effect.catch((error) =>
              Schema.is(StoreError)(error)
                ? Effect.fail(storeFailure(error))
                : Effect.succeed({
                    result: {
                      _tag: "Rejected" as const,
                      reason: Schema.is(HostedThreadApplicationError)(error) ? "unavailable" : error.kind,
                      message: error.message,
                    },
                    events: [] as ReadonlyArray<InteractiveEvent>,
                  }),
            ),
          )
          const completedAt =
            "completedAt" in applied
              ? applied.completedAt
              : DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
          const completionSnapshot =
            "completed" in applied
              ? undefined
              : yield* operations
                  .snapshot(authority.ownerId, ProductThreadId.make(threadId))
                  .pipe(Effect.mapError(operationFailure))
          const completed =
            "completed" in applied
              ? applied.completed
              : yield* store
                  .completeCommand({
                    ownerId: authority.ownerId,
                    threadId,
                    commandId: command.commandId,
                    result: applied.result,
                    events: applied.events,
                    snapshot: completionSnapshot!,
                    completedAt,
                  })
                  .pipe(Effect.mapError(storeFailure))
          return [
            frame(commandResult(completed, message.requestId)),
            ...applied.events.map((event, index) => {
              const cursor = String(BigInt(completed.cursor ?? zeroCursor) - BigInt(applied.events.length - index - 1))
              return frame({
                _tag: "ThreadEvent",
                event: {
                  threadId,
                  sequence: Sequence.make(cursor),
                  cursor: ThreadEventCursor.make(cursor),
                  threadVersion: completed.threadVersion,
                  event,
                  createdAt: completed.completedAt ?? completedAt,
                },
              })
            }),
          ]
        })

        return {
          receive: (message) =>
            receiveUnsafe(message).pipe(
              Effect.catch((error) => reject(message, error)),
              Effect.orDie,
            ),
          active: Effect.gen(function* () {
            const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis))
            if (attached === undefined) {
              yield* hosted.validateClient({
                userId: binding.userId,
                clientId: binding.clientId,
                deviceId: binding.deviceId,
                at,
              })
              return true
            }
            yield* product
              .authorizeThread(principal, attached.threadId, "thread:view")
              .pipe(Effect.mapError(productFailure))
            return true
          }).pipe(Effect.orElseSucceed(() => false)),
          detach: Effect.sync(() => (attached = undefined)),
        }
      },
    )

    return HostedThreadProtocol.of({ issueTicket, connect })
  }),
)
