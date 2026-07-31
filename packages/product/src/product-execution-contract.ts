import { Context, Effect, Schema } from "effect"
import type { ExecutionRouteModelSnapshot, ExecutionRouteSnapshot } from "./execution-route-snapshot"
import * as ExecutionIngestModule from "./execution-ingest"

export const ExecutionIngest = ExecutionIngestModule

export const Status = Schema.Literals(["accepted", "queued", "running", "waiting", "completed", "failed", "cancelled"])
export type Status = typeof Status.Type

export const Event = Schema.Struct({
  executionId: Schema.String,
  childExecutionId: Schema.optionalKey(Schema.String),
  cursor: Schema.String,
  sequence: Schema.Finite,
  type: Schema.String,
  createdAt: Schema.Finite,
  timestampSource: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type Event = typeof Event.Type

export type PromptPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly data: string; readonly filename?: string }

export type ExecutionModelRoute = ExecutionRouteModelSnapshot
export type ExecutionRoutePin = ExecutionRouteSnapshot

export type SessionPurpose = { readonly _tag: "Conversation" }

export interface StartInput {
  readonly threadId: string
  readonly turnId: string
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly extensionPin?: ExecutionExtensionPin
  readonly executionRoute: ExecutionRoutePin
  readonly reasoningEffort?: string
  readonly fastMode?: boolean
  readonly eventScope?: EventScope
  readonly sessionPurpose?: SessionPurpose
  readonly onEvent?: (event: Event) => void
}

export type EventScope = "execution" | "tree"

export interface ExecutionReference {
  readonly _tag: "ExecutionReference"
}

export const executionReference: ExecutionReference = { _tag: "ExecutionReference" }

export interface ExecutionExtensionPin {
  readonly generation: string
  readonly sourceDigest: string
  readonly configFingerprint: string
  readonly toolSchemaDigest: string
  readonly mcpFingerprint: string
  readonly resolvedContextDigest: string
}

export const AgentProfile = Schema.Literals([
  "Oracle",
  "Librarian",
  "Painter",
  "Review",
  "ReadThread",
  "Surgeon",
  "Task",
])
export type AgentProfile = typeof AgentProfile.Type

export type JoinPolicy = "all" | "first-success" | "quorum" | "best-effort"
export interface FanOutInput {
  readonly parentTurnId: string
  readonly fanOutId: string
  readonly workspace?: string
  readonly executionRoute: ExecutionRoutePin
  readonly children: ReadonlyArray<{
    readonly childId: string
    readonly profile?: AgentProfile
    readonly prompt: string
  }>
  readonly maxConcurrency: number
  readonly join: JoinPolicy
  readonly quorum?: number
  readonly createdAt: number
}
export interface FanOutInspection {
  readonly fanOutId: string
  readonly parentTurnId: string
  readonly state: "joining" | "satisfied" | "failed" | "cancelled"
  readonly maxConcurrency: number
  readonly join: JoinPolicy
  readonly members: ReadonlyArray<{
    readonly childId: string
    readonly ordinal: number
    readonly state: Status
    readonly output?: unknown
    readonly error?: string
  }>
}
export interface ChildProjection {
  readonly parentTurnId: string
  readonly fanOutId: string
  readonly childId: string
  readonly ordinal: number
  readonly state: Status
  readonly output?: unknown
  readonly error?: string
}
export interface WorkflowInspection {
  readonly runId: string
  readonly ownerTurnId?: string
  readonly workflow: string
  readonly revision: number
  readonly digest: string
  readonly status: "running" | "completed" | "failed" | "cancelled"
  readonly createdAt: number
  readonly updatedAt: number
}

export interface InvokeChildInput {
  readonly parentTurnId: string
  readonly childId: string
  readonly profile: AgentProfile | "Title"
  readonly prompt: string
}

export interface ChildEvent {
  readonly parentTurnId: string
  readonly childId: string
  readonly profile: AgentProfile | "Title"
  readonly type: "accepted"
}

export interface Result {
  readonly turnId: string
  readonly status: Status
  readonly events: ReadonlyArray<Event>
  readonly checkpoint?: ExecutionCheckpoint
}

export interface ExecutionCheckpoint {
  readonly cursor: string
  readonly sequence: number
}

export interface InvocationSource {
  readonly rootTurnId: string
  readonly threadId: string
  readonly callerProfile: AgentProfile | "Root" | "Title"
  readonly threadCreationDepth: number
}

export interface SteerReceipt {
  readonly steeringMessageId: string
  readonly sequence: number
}

export interface PendingApproval {
  readonly waitId: string
  readonly executionId: string
  readonly callId: string
  readonly toolName: string
  readonly input: unknown
  readonly requestedAt: number
}

export interface EventPage {
  readonly events: ReadonlyArray<Event>
  readonly hasMore: boolean
  readonly oldestCursor?: string
  readonly newestCursor?: string
}

export interface Inspection {
  readonly turnId: string
  readonly status: Status
  readonly createdAt?: number
  readonly lastCursor?: string
  readonly waits: ReadonlyArray<{ readonly id: string; readonly mode: string; readonly createdAt: number }>
  readonly pendingTools: ReadonlyArray<{
    readonly callId: string
    readonly name: string
    readonly input: unknown
    readonly requestedAt: number
  }>
  readonly children: ReadonlyArray<{ readonly executionId: string; readonly status: Status }>
}

export class BackendError extends Schema.TaggedErrorClass<BackendError>()("ExecutionBackendError", {
  message: Schema.String,
}) {}

export interface ThreadQueueWake {
  readonly threadId: string
  readonly generation: number
  readonly queueRevision: number
  readonly now: number
}

export type TurnPromoter = (threadId: string, generation: number) => Effect.Effect<number>

export interface OpenRootExecution {
  readonly executionId: string
  readonly turnId: string | undefined
  readonly createdAt: number
}

export interface Interface {
  readonly invokeChild: (input: InvokeChildInput) => Effect.Effect<ChildEvent, BackendError>
  readonly createFanOut: (input: FanOutInput) => Effect.Effect<FanOutInspection, BackendError>
  readonly inspectFanOut: (fanOutId: string) => Effect.Effect<FanOutInspection | undefined, BackendError>
  readonly cancelFanOut: (
    fanOutId: string,
    cancelledAt: number,
    reason?: string,
  ) => Effect.Effect<FanOutInspection, BackendError>
  readonly registerWorkflows: (
    _?: void,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly name: string; readonly revision: number; readonly digest: string }>,
    BackendError
  >
  readonly startWorkflow: (
    name: string,
    runId: string,
    revision?: number,
    ownerTurnId?: string,
    workspace?: string,
  ) => Effect.Effect<WorkflowInspection, BackendError>
  readonly inspectWorkflow: (
    runId: string,
    ownerTurnId?: string,
    workspace?: string,
  ) => Effect.Effect<WorkflowInspection | undefined, BackendError>
  readonly cancelWorkflow: (
    runId: string,
    ownerTurnId?: string,
    workspace?: string,
  ) => Effect.Effect<WorkflowInspection | undefined, BackendError>
  readonly wakeThreadHost?: (wake: ThreadQueueWake) => Effect.Effect<void, BackendError>
  readonly registerTurnPromoter?: (promoter: TurnPromoter) => Effect.Effect<void>
  readonly start: (input: StartInput) => Effect.Effect<Result, BackendError>
  readonly follow?: (
    turnId: string,
    afterCursor: string | ExecutionCheckpoint | undefined,
    onEvent?: (event: Event) => void,
    reference?: ExecutionReference,
    eventScope?: EventScope,
  ) => Effect.Effect<Result, BackendError>
  readonly replay: (
    turnId: string,
    afterCursor?: string | ExecutionCheckpoint,
    reference?: ExecutionReference,
  ) => Effect.Effect<Result, BackendError>
  readonly pageEvents?: (
    turnId: string,
    direction: "forward" | "backward",
    cursor?: string,
    limit?: number,
    reference?: ExecutionReference,
  ) => Effect.Effect<EventPage, BackendError>
  readonly listOpenRootExecutions?: Effect.Effect<ReadonlyArray<OpenRootExecution>, BackendError>
  readonly cancel: (turnId: string, reference?: ExecutionReference) => Effect.Effect<Result, BackendError>
  readonly inspect: (
    turnId: string,
    reference?: ExecutionReference,
  ) => Effect.Effect<Inspection | undefined, BackendError>
  readonly resolveInvocationSource: (executionId: string) => Effect.Effect<InvocationSource, BackendError>
  readonly steer: (
    turnId: string,
    text: string,
    idempotencyIdentity: string,
    reference?: ExecutionReference,
  ) => Effect.Effect<SteerReceipt, BackendError>
  readonly listApprovals?: (
    turnId: string,
    reference?: ExecutionReference,
  ) => Effect.Effect<ReadonlyArray<PendingApproval>, BackendError>
  readonly resolveToolApproval?: (
    waitId: string,
    approved: boolean,
    resolvedAt: number,
    comment?: string,
  ) => Effect.Effect<void, BackendError>
  readonly resolvePermission?: (
    waitId: string,
    answer: "Always" | "Approved" | "Denied",
    resolvedAt: number,
    reason?: string,
  ) => Effect.Effect<void, BackendError>
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/product-execution-contract/Service",
) {}

export const AgentDepth = {
  childExecutionId: (parentExecutionId: string, childId: string): string =>
    `child:${encodeURIComponent(parentExecutionId)}:${childId}`,
  childExecutionDepth: (executionId: string): number => {
    let depth = 0
    let current = executionId
    while (current.startsWith("child:")) {
      const separator = current.indexOf(":", "child:".length)
      if (separator < 0) break
      depth += 1
      current = decodeURIComponent(current.slice("child:".length, separator))
    }
    return depth
  },
}
