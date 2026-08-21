import { Schema } from "effect"
import * as ExecutionProjection from "../../execution/contract/execution-projection"
import { InteractiveEventSchema, type InteractiveEvent } from "../../operation/interactive/event"
import * as Thread from "../../thread/model/thread-record"
import * as Turn from "../../thread/model/turn-record"
import * as TranscriptUnit from "@rika/transcript/transcript-unit"
import {
  ActorAttribution,
  CommandId,
  IdempotencyKey,
  JsonObject,
  ProjectId,
  RequestId,
  Sequence,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "../model"
import { LocalRunnerTarget } from "../local-runner-registration"
import { RepositoryService, WorkspaceFileInspection } from "../workspace-capability"

export const protocolVersion = 1 as const

export const isDurableThreadEvent = (event: InteractiveEvent) =>
  event._tag !== "ExecutionModelPreviewChanged" &&
  event._tag !== "ThreadPreviewLoaded" &&
  event._tag !== "ThreadPreviewFailed" &&
  Schema.is(InteractiveEventSchema)(event)

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const OwnerSelection = Schema.Union([
  strict(Schema.Struct({ kind: Schema.Literal("personal") })),
  strict(Schema.Struct({ kind: Schema.Literal("organization"), organizationId: Schema.NonEmptyString })),
])
const RepositoryRef = strict(
  Schema.Struct({
    repositoryId: Schema.NonEmptyString,
    ref: Schema.NonEmptyString,
  }),
)
const Attachment = strict(
  Schema.Struct({
    mediaType: Schema.NonEmptyString,
    data: Schema.String,
    filename: Schema.optionalKey(Schema.NonEmptyString),
  }),
)
const mutating = {
  commandId: CommandId,
  idempotencyKey: IdempotencyKey,
  expectedThreadVersion: ThreadVersion,
} as const

export const MutatingThreadCommand = Schema.Union([
  strict(
    Schema.TaggedStruct("SubmitPrompt", {
      ...mutating,
      text: Schema.NonEmptyString,
      mode: Schema.optionalKey(Schema.NonEmptyString),
      attachments: Schema.optionalKey(Schema.Array(Attachment)),
    }),
  ),
  strict(
    Schema.TaggedStruct("Steer", {
      ...mutating,
      text: Schema.NonEmptyString,
      targetTurnId: Schema.optionalKey(Turn.TurnId),
    }),
  ),
  strict(
    Schema.TaggedStruct("InterruptAndSend", {
      ...mutating,
      text: Schema.NonEmptyString,
    }),
  ),
  strict(Schema.TaggedStruct("Cancel", mutating)),
  strict(
    Schema.TaggedStruct("Approve", {
      ...mutating,
      turnId: Turn.TurnId,
      authorizationId: Schema.NonEmptyString,
      checkpoint: ExecutionProjection.Checkpoint,
    }),
  ),
  strict(
    Schema.TaggedStruct("Deny", {
      ...mutating,
      turnId: Turn.TurnId,
      authorizationId: Schema.NonEmptyString,
      checkpoint: ExecutionProjection.Checkpoint,
    }),
  ),
  strict(
    Schema.TaggedStruct("EnsureRepositoryService", {
      ...mutating,
      service: RepositoryService,
    }),
  ),
  strict(
    Schema.TaggedStruct("StopRepositoryService", {
      ...mutating,
      serviceId: Schema.NonEmptyString,
    }),
  ),
])
export type MutatingThreadCommand = typeof MutatingThreadCommand.Type

const CreateThread = strict(
  Schema.TaggedStruct("CreateThread", {
    ...mutating,
    owner: OwnerSelection,
    projectId: Schema.optionalKey(ProjectId),
    placement: Schema.Literals(["local", "e2b"]),
    localRunnerTarget: Schema.optionalKey(LocalRunnerTarget),
    repositoryRef: Schema.optionalKey(RepositoryRef),
  }),
).check(
  Schema.makeFilter((command) =>
    (command.placement === "local") === (command.localRunnerTarget !== undefined)
      ? []
      : [{ path: ["localRunnerTarget"], issue: "local placement requires exactly one local runner target" }],
  ),
)

export const ClientCommand = Schema.Union([
  CreateThread,
  strict(
    Schema.TaggedStruct("AttachThread", {
      threadId: ThreadId,
      afterCursor: ThreadEventCursor,
    }),
  ),
  MutatingThreadCommand,
  strict(
    Schema.TaggedStruct("InspectWorkspaceFile", {
      path: Schema.NonEmptyString,
      maximumBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_048_576)),
    }),
  ),
  strict(
    Schema.TaggedStruct("AcknowledgeCursor", {
      cursor: ThreadEventCursor,
    }),
  ),
  strict(Schema.TaggedStruct("Detach", {})),
])
export type ClientCommand = typeof ClientCommand.Type

export const ClientMessage = strict(
  Schema.Struct({
    protocolVersion: Schema.Literal(protocolVersion),
    requestId: RequestId,
    command: ClientCommand,
  }),
)
export type ClientMessage = typeof ClientMessage.Type

export const PendingAuthorization = strict(
  Schema.Struct({
    threadId: ThreadId,
    turnId: Turn.TurnId,
    authorizationId: Schema.NonEmptyString,
    operation: Schema.String,
    capability: Schema.String,
    input: Schema.String,
    inputTruncated: Schema.Boolean,
    checkpoint: ExecutionProjection.Checkpoint,
  }),
)
export type PendingAuthorization = typeof PendingAuthorization.Type

export const HostedThreadSnapshot = strict(
  Schema.Struct({
    thread: Thread.Thread,
    turns: Schema.Array(Turn.Turn),
    units: Schema.Array(TranscriptUnit.Unit),
    queue: strict(
      Schema.Struct({
        revision: NonNegativeInt,
        turns: Schema.Array(Turn.AgentExecutionTurn),
      }),
    ),
    pendingAuthorizations: Schema.Array(PendingAuthorization),
  }),
)
export type HostedThreadSnapshot = typeof HostedThreadSnapshot.Type

export const ThreadProtocolEvent = strict(
  Schema.Struct({
    threadId: ThreadId,
    sequence: Sequence,
    cursor: ThreadEventCursor,
    threadVersion: ThreadVersion,
    event: InteractiveEventSchema,
    createdAt: Timestamp,
  }),
)
export type ThreadProtocolEvent = typeof ThreadProtocolEvent.Type

const CommandResult = Schema.Union([
  strict(Schema.TaggedStruct("ThreadCreated", { threadId: ThreadId })),
  strict(Schema.TaggedStruct("Applied", {})),
])
export type CommandResult = typeof CommandResult.Type

const ServerPayload = Schema.Union([
  strict(
    Schema.TaggedStruct("CommandAccepted", {
      requestId: RequestId,
      commandId: Schema.optionalKey(CommandId),
      threadId: ThreadId,
      threadVersion: ThreadVersion,
      cursor: ThreadEventCursor,
      result: CommandResult,
    }),
  ),
  strict(
    Schema.TaggedStruct("CommandRejected", {
      requestId: RequestId,
      commandId: Schema.optionalKey(CommandId),
      threadId: Schema.optionalKey(ThreadId),
      reason: Schema.Literals(["invalid", "forbidden", "not-found", "conflict", "stale-version", "unavailable"]),
      currentThreadVersion: Schema.optionalKey(ThreadVersion),
      currentCursor: Schema.optionalKey(ThreadEventCursor),
      message: Schema.String,
      details: JsonObject,
    }),
  ),
  strict(
    Schema.TaggedStruct("ThreadSnapshot", {
      requestId: Schema.optionalKey(RequestId),
      threadId: ThreadId,
      threadVersion: ThreadVersion,
      cursor: ThreadEventCursor,
      snapshot: HostedThreadSnapshot,
    }),
  ),
  strict(Schema.TaggedStruct("ThreadEvent", { event: ThreadProtocolEvent })),
  strict(Schema.TaggedStruct("ExecutorStatus", { threadId: ThreadId, status: JsonObject })),
  strict(Schema.TaggedStruct("WorkspaceStatus", { threadId: ThreadId, status: JsonObject })),
  strict(
    Schema.TaggedStruct("WorkspaceFileInspected", {
      requestId: RequestId,
      threadId: ThreadId,
      inspection: WorkspaceFileInspection,
    }),
  ),
  strict(
    Schema.TaggedStruct("PresenceSnapshot", {
      threadId: ThreadId,
      controllers: Schema.Array(ActorAttribution),
    }),
  ),
  strict(Schema.TaggedStruct("Heartbeat", { at: Timestamp })),
])

export const ServerFrame = strict(
  Schema.Struct({
    protocolVersion: Schema.Literal(protocolVersion),
    payload: ServerPayload,
  }),
)
export type ServerFrame = typeof ServerFrame.Type

export const ClientTicketResponse = strict(
  Schema.Struct({
    ticket: Schema.String,
    expiresAt: Timestamp,
    websocketUrl: Schema.String,
    protocol: Schema.Literal("rika.thread.v1"),
  }),
)
export type ClientTicketResponse = typeof ClientTicketResponse.Type

export const CommandRejection = strict(
  Schema.Struct({
    reason: Schema.Literals(["conflict", "stale-version", "failed"]),
    message: Schema.String,
    details: JsonObject,
  }),
)
export type CommandRejection = typeof CommandRejection.Type
