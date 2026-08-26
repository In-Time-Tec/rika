import { Function, Option, Schema } from "effect"
import * as ExecutionProjection from "../../execution/projection/contract"
import { InteractiveEventSchema, type InteractiveEvent } from "../../operation/interactive/event"
import * as Turn from "../../thread/turn/record"
import * as ThreadView from "../../thread/view/model"
import {
  ActorAttribution,
  CommandId,
  ExecutorKind,
  IdempotencyKey,
  JsonObject,
  ProjectId,
  PresenceStatus,
  RequestId,
  Sequence,
  ThreadEventCursor,
  ThreadId,
  ThreadVersion,
  Timestamp,
} from "../model"
import { RunnerTarget } from "../executor/runner-registration"
import { RepositoryService, WorkspaceFileInspection } from "../environment/workspace-capability"

export const protocolVersion = 2 as const
export const protocolMismatchCloseCode = 1003
export const protocolMismatchMessage = "Client outdated, upgrade rika"

const ProtocolInspection = Schema.Struct({
  protocolVersion: Schema.optionalKey(Schema.Unknown),
  requestId: Schema.optionalKey(Schema.Unknown),
})
export type ProtocolInspection = typeof ProtocolInspection.Type

const ProtocolMismatchWire = Schema.Struct({
  protocolVersion: Schema.Finite,
  payload: Schema.TaggedStruct("CommandRejected", {
    requestId: Schema.NonEmptyString,
    reason: Schema.Literal("unavailable"),
    message: Schema.String,
    details: Schema.Struct({
      expectedProtocolVersion: Schema.Finite,
      receivedProtocolVersion: Schema.NullOr(Schema.Unknown),
    }),
  }),
})

export const inspectClientProtocolVersion = (body: string): ProtocolInspection =>
  Option.getOrElse(Schema.decodeOption(Schema.fromJsonString(ProtocolInspection))(body), () => ({}))

const mismatchProtocolVersion = (value: ProtocolInspection["protocolVersion"]) =>
  Schema.is(Schema.Finite)(value) ? value : 1

const mismatchRequestId = (value: ProtocolInspection["requestId"]) =>
  Schema.is(Schema.NonEmptyString)(value) ? value : "protocol"

export const protocolMismatchFrame = (inspection: ProtocolInspection): string =>
  Schema.encodeSync(Schema.fromJsonString(ProtocolMismatchWire))({
    protocolVersion: mismatchProtocolVersion(inspection.protocolVersion),
    payload: {
      _tag: "CommandRejected",
      requestId: mismatchRequestId(inspection.requestId),
      reason: "unavailable",
      message: protocolMismatchMessage,
      details: {
        expectedProtocolVersion: protocolVersion,
        receivedProtocolVersion: inspection.protocolVersion ?? null,
      },
    },
  })

export const isDurableThreadEvent = (event: InteractiveEvent) =>
  event._tag !== "ExecutionModelPreviewChanged" &&
  event._tag !== "ThreadPreviewLoaded" &&
  event._tag !== "ThreadPreviewFailed" &&
  Schema.is(InteractiveEventSchema)(event)

export const interactiveEventThreadId = (event: InteractiveEvent): string | undefined => {
  switch (event._tag) {
    case "ThreadViewSnapshot":
      return String(event.snapshot.thread.id)
    case "ThreadViewPatch":
      return String(event.patch.threadId)
    case "ResyncRequired":
    case "ExecutionModelPreviewChanged":
    case "ContextDiagnostics":
    case "ThreadRefolding":
    case "QueueFull":
    case "SubmissionAdmitted":
    case "ShellCompleted":
    case "ThreadTitled":
    case "GoalChanged":
    case "ThreadActivated":
    case "ThreadPreviewLoaded":
    case "ThreadPreviewFailed":
    case "TurnRetryScheduled":
      return String(event.threadId)
    case "ExecutionFailed":
    case "ExecutionControlFailed":
    case "ExecutionControlled":
    case "SubmissionRejected":
      return event.threadId === undefined ? undefined : String(event.threadId)
    case "ThreadsListed":
    case "AssistantCompleted":
      return undefined
  }
}

const strict = <S extends Schema.Top>(schema: S) => schema.annotate({ parseOptions: { onExcessProperty: "error" } })
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
const admitted = {
  commandId: CommandId,
  idempotencyKey: IdempotencyKey,
  expectedThreadVersion: ThreadVersion,
} as const
const mutating = { threadId: ThreadId, ...admitted } as const
const CancellationTarget = Schema.Union([
  strict(Schema.TaggedStruct("Turn", { turnId: Turn.TurnId })),
  strict(Schema.TaggedStruct("Command", { commandId: CommandId })),
])

export const MutatingThreadCommand = Schema.Union([
  strict(
    Schema.TaggedStruct("SubmitPrompt", {
      ...mutating,
      text: Schema.NonEmptyString,
      submissionId: Schema.optionalKey(Schema.NonEmptyString),
      mode: Schema.optionalKey(Schema.NonEmptyString),
      attachments: Schema.optionalKey(Schema.Array(Attachment)),
    }),
  ),
  strict(
    Schema.TaggedStruct("Steer", {
      ...mutating,
      text: Schema.NonEmptyString,
      targetTurnId: Turn.TurnId,
    }),
  ),
  strict(
    Schema.TaggedStruct("InterruptAndSend", {
      ...mutating,
      text: Schema.NonEmptyString,
      targetTurnId: Turn.TurnId,
    }),
  ),
  strict(Schema.TaggedStruct("Cancel", { ...mutating, target: CancellationTarget })),
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

export const CreateThreadCommand = strict(
  Schema.TaggedStruct("CreateThread", {
    ...admitted,
    owner: OwnerSelection,
    projectId: Schema.optionalKey(ProjectId),
    executorKind: ExecutorKind,
    runnerTarget: Schema.optionalKey(RunnerTarget),
    repositoryRef: Schema.optionalKey(RepositoryRef),
  }),
).check(
  Schema.makeFilter((command) =>
    (command.executorKind === "runner") === (command.runnerTarget !== undefined)
      ? []
      : [{ path: ["runnerTarget"], issue: "runner requires exactly one Runner target" }],
  ),
)
export type CreateThreadCommand = typeof CreateThreadCommand.Type

export const ClientCommand = Schema.Union([
  CreateThreadCommand,
  strict(
    Schema.TaggedStruct("AttachThread", {
      threadId: ThreadId,
      afterCursor: ThreadEventCursor,
    }),
  ),
  MutatingThreadCommand,
  strict(
    Schema.TaggedStruct("InspectWorkspaceFile", {
      threadId: ThreadId,
      path: Schema.NonEmptyString,
      maximumBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(1_048_576)),
    }),
  ),
  strict(
    Schema.TaggedStruct("AcknowledgeCursor", {
      threadId: ThreadId,
      cursor: ThreadEventCursor,
    }),
  ),
  strict(Schema.TaggedStruct("UpdatePresence", { threadId: ThreadId, status: PresenceStatus })),
  strict(
    Schema.TaggedStruct("OpenPortal", {
      threadId: ThreadId,
      port: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })),
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

export const WorkspacePlacement = Schema.Union([
  strict(
    Schema.TaggedStruct("RunnerWorkspace", {
      state: Schema.Literals(["disconnected", "ready"]),
    }),
  ),
  strict(
    Schema.TaggedStruct("OrbWorkspace", {
      state: Schema.Literals(["unassigned", "preparing", "ready", "failed"]),
      generation: Schema.String,
      attempt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
      phase: Schema.optionalKey(Schema.Literals(["checkout", "setup", "resume", "capabilities"])),
      deadlineAt: Schema.optionalKey(Schema.Finite),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
])
export type WorkspacePlacement = typeof WorkspacePlacement.Type

export const HostedThreadSnapshot = strict(
  Schema.Struct({
    executorKind: ExecutorKind,
    workspace: Schema.optionalKey(WorkspacePlacement),
    view: ThreadView.ThreadViewSnapshot,
    pendingAuthorizations: Schema.Array(PendingAuthorization),
  }),
)
export type HostedThreadSnapshot = typeof HostedThreadSnapshot.Type

export const hostedThreadSnapshotMatches: {
  (threadId: string): (snapshot: HostedThreadSnapshot) => boolean
  (snapshot: HostedThreadSnapshot, threadId: string): boolean
} = Function.dual(
  2,
  (snapshot: HostedThreadSnapshot, threadId: string) =>
    String(snapshot.view.thread.id) === threadId &&
    snapshot.pendingAuthorizations.every((authorization) => String(authorization.threadId) === threadId),
)

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

export const PromptAdmissionStatus = Schema.Literals(["accepted", "queued"])
export type PromptAdmissionStatus = typeof PromptAdmissionStatus.Type

export const CommandResult = Schema.Union([
  strict(Schema.TaggedStruct("ThreadCreated", { threadId: ThreadId })),
  strict(Schema.TaggedStruct("PromptAdmitted", { status: PromptAdmissionStatus })),
  strict(Schema.TaggedStruct("Applied", {})),
])
export type CommandResult = typeof CommandResult.Type

const PresenceParticipant = Schema.Struct({ actor: ActorAttribution, status: PresenceStatus })

const ServerPayload = Schema.Union([
  strict(
    Schema.TaggedStruct("CommandAdmitted", {
      requestId: RequestId,
      commandId: CommandId,
      threadId: ThreadId,
      threadVersion: ThreadVersion,
    }),
  ),
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
    Schema.TaggedStruct("ThreadAttached", {
      requestId: RequestId,
      threadId: ThreadId,
      snapshotThreadVersion: ThreadVersion,
      snapshotCursor: ThreadEventCursor,
      threadVersion: ThreadVersion,
      cursor: ThreadEventCursor,
      snapshot: HostedThreadSnapshot,
      events: Schema.Array(ThreadProtocolEvent),
      participants: Schema.Array(PresenceParticipant),
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
  strict(
    Schema.TaggedStruct("WorkspaceFileInspected", {
      requestId: RequestId,
      threadId: ThreadId,
      inspection: WorkspaceFileInspection,
    }),
  ),
  strict(
    Schema.TaggedStruct("PortalOpened", {
      requestId: RequestId,
      threadId: ThreadId,
      port: Schema.Int,
      url: Schema.String,
    }),
  ),
  strict(
    Schema.TaggedStruct("PresenceSnapshot", {
      threadId: ThreadId,
      participants: Schema.Array(PresenceParticipant),
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
