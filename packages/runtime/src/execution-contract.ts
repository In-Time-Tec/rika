import { Context, Effect, Schema } from "effect"
import type { ModelRegistry } from "@batonfx/core"

export const Status = Schema.Literals(["accepted", "queued", "running", "waiting", "completed", "failed", "cancelled"])
export type Status = typeof Status.Type

export const Event = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  executionId: Schema.optionalKey(Schema.String),
  childExecutionId: Schema.optionalKey(Schema.String),
  cursor: Schema.String,
  sequence: Schema.Finite,
  type: Schema.String,
  createdAt: Schema.Finite,
  text: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  data: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
})
export type Event = typeof Event.Type

export type PromptPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly data: string; readonly filename?: string }

export interface ExecutionModelRoute {
  readonly role: "main" | "oracle" | "title" | "compaction" | "librarian" | "painter" | "review" | "readThread" | "task"
  readonly alias: string
  readonly provider: string
  readonly model: string
  readonly registrationKey: string
  readonly providerProtocol: string
  readonly providerBaseUrl: string
  readonly providerApiKeyEnv?: string
  readonly providerRuntime?: {
    readonly adapter: string
    readonly credentialIdentity?: string
    readonly connectionIdentity?: Readonly<Record<string, string>>
  }
  readonly openAiAccountFingerprint?: string
  readonly effort: string
  readonly fast: boolean
  readonly requestVariant: string
  readonly providerOptions?: Readonly<Record<string, unknown>>
  readonly compaction: {
    readonly contextWindow: number
    readonly reserveTokens: number
    readonly keepRecentTokens: number
  }
}

export interface ExecutionRoutePin {
  readonly mode: "low" | "medium" | "high" | "ultra" | "test"
  readonly tokenBudget?: number
  readonly title?: ExecutionModelRoute
  readonly compactionSummary?: ExecutionModelRoute
  readonly main: ExecutionModelRoute
  readonly oracle: ExecutionModelRoute
  readonly agents?: {
    readonly librarian: ExecutionModelRoute
    readonly painter: ExecutionModelRoute
    readonly review: ExecutionModelRoute
    readonly readThread: ExecutionModelRoute
    readonly task: ExecutionModelRoute
  }
}

export type SessionPurpose =
  | { readonly _tag: "Conversation" }
  | { readonly _tag: "ThreadTitle"; readonly owningTurnId: string }

export interface StartInput {
  readonly threadId: string
  readonly turnId: string
  readonly prompt: string
  readonly promptParts?: ReadonlyArray<PromptPart>
  readonly startedAt: number
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

export type AgentProfile = "Oracle" | "Librarian" | "Painter" | "Review" | "ReadThread" | "Task"

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
    readonly model?: string
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
  readonly profile: AgentProfile
  readonly prompt: string
}

export interface ChildEvent {
  readonly parentTurnId: string
  readonly childId: string
  readonly profile: AgentProfile
  readonly type: "accepted"
}

export interface Result {
  readonly turnId: string
  readonly status: Status
  readonly events: ReadonlyArray<Event>
}

export interface SteerReceipt {
  readonly steeringMessageId: string
  readonly sequence: number
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

export interface Approval {
  readonly waitId: string
  readonly executionId?: string
  readonly callId: string
  readonly toolName: string
  readonly input: unknown
  readonly requestedAt: number
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

export interface Interface {
  readonly registerModels?: (
    registrations: ReadonlyArray<ModelRegistry.Registration>,
  ) => Effect.Effect<void, BackendError>
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
    afterCursor: string | undefined,
    onEvent?: (event: Event) => void,
    reference?: ExecutionReference,
    eventScope?: EventScope,
  ) => Effect.Effect<Result, BackendError>
  readonly replay: (
    turnId: string,
    afterCursor?: string,
    reference?: ExecutionReference,
  ) => Effect.Effect<Result, BackendError>
  readonly pageEvents?: (
    turnId: string,
    direction: "forward" | "backward",
    cursor?: string,
    limit?: number,
    reference?: ExecutionReference,
  ) => Effect.Effect<EventPage, BackendError>
  readonly cancel: (
    turnId: string,
    cancelledAt: number,
    reference?: ExecutionReference,
  ) => Effect.Effect<Result, BackendError>
  readonly inspect: (
    turnId: string,
    reference?: ExecutionReference,
  ) => Effect.Effect<Inspection | undefined, BackendError>
  readonly steer: (
    turnId: string,
    text: string,
    createdAt: number,
    reference?: ExecutionReference,
  ) => Effect.Effect<SteerReceipt, BackendError>
  readonly listApprovals: (
    turnId: string,
    reference?: ExecutionReference,
  ) => Effect.Effect<ReadonlyArray<Approval>, BackendError>
  readonly resolveToolApproval: (
    waitId: string,
    approved: boolean,
    resolvedAt: number,
    comment?: string,
  ) => Effect.Effect<void, BackendError>
  readonly resolvePermission: (
    waitId: string,
    answer: "Approved" | "Denied" | "Always",
    resolvedAt: number,
    reason?: string,
  ) => Effect.Effect<void, BackendError>
}

export class Service extends Context.Service<Service, Interface>()("@rika/runtime/execution-contract/Service") {}
