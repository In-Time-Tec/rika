import { Effect, Schema } from "effect"
import type {
  ToolOperationLifecycleFrame as ToolOperationLifecycleFrameValue,
  ToolOperationResponse as ToolOperationResponseValue,
  ToolOperationTerminalOutcome as ToolOperationTerminalOutcomeValue,
} from "@rika/product/tool-operation-lifecycle"
import { rikaHostedRunnerAdmissions } from "../../database/schema/product"

export class HostedExecutionOperationsError extends Schema.TaggedError<HostedExecutionOperationsError>()(
  "HostedExecutionOperationsError",
  { message: Schema.String },
) {}

export interface OperationIdentity {
  readonly assignmentId: string
  readonly operationKey: string
  readonly requestDigest: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly threadId: string
  readonly turnId: string
  readonly runId: string
  readonly rootRunId: string
  readonly toolCallId: string
  readonly code: string
  readonly attempt: number
  readonly replayPolicy: "pure" | "provider-idempotent" | "never"
  readonly admittedAt: string | null
  readonly deadlineAt: string
}

export interface DispatchFence {
  readonly assignmentGeneration: number
  readonly leaseEpoch: number
  readonly providerInstanceId: string
  readonly executorInstanceId: string
  readonly processIncarnation: string
}

export interface OperationRecord extends OperationIdentity {
  readonly ownerId: string
  readonly state: "accepted" | "dispatched" | "completed" | "unknown"
  readonly started: boolean
  readonly dispatchedGeneration: number | null
  readonly dispatchedLeaseEpoch: number | null
  readonly dispatchedExecutorInstanceId: string | null
  readonly dispatchedProcessIncarnation: string | null
  readonly response: ToolOperationResponseValue | null
  readonly terminalOutcome: ToolOperationTerminalOutcomeValue | null
}

export type AppendFrameResult = "appended" | "duplicate" | "already-terminal" | "invalid-sequence"

export interface FinalizeOperationInput {
  readonly assignmentId: string
  readonly operationKey: string
  readonly attempt: number
  readonly response: ToolOperationResponseValue
  readonly state: "completed" | "unknown"
  readonly completionFence?: Omit<DispatchFence, "providerInstanceId">
  readonly expectedFence?: Omit<DispatchFence, "providerInstanceId">
  readonly onFinalize?: (result: FinalizedOperation) => Effect.Effect<void, HostedExecutionOperationsError>
}

export interface FinalizedOperation {
  readonly _tag: "finalized"
  readonly response: ToolOperationResponseValue
  readonly outcome: NonNullable<OperationRecord["terminalOutcome"]>
  readonly commandSequence: number
  readonly fence: Omit<DispatchFence, "providerInstanceId">
}

export type FinalizeOperationResult =
  | FinalizedOperation
  | {
      readonly _tag: "already-terminal"
      readonly response: ToolOperationResponseValue
      readonly outcome: NonNullable<OperationRecord["terminalOutcome"]>
    }
  | {
      readonly _tag:
        | "missing"
        | "not-dispatched"
        | "incomplete-fence"
        | "completion-fence-mismatch"
        | "expected-fence-mismatch"
        | "response-conflict"
        | "command-missing"
    }

export interface HostedExecutionOperationsService {
  readonly findOperation: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
    lock?: "update",
  ) => Effect.Effect<OperationRecord | undefined, HostedExecutionOperationsError>
  readonly upsertOperation: (
    identity: OperationIdentity,
  ) => Effect.Effect<OperationRecord | undefined, HostedExecutionOperationsError>
  readonly claimDispatch: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt" | "threadId" | "turnId" | "workspaceId">,
    fence: DispatchFence,
    sessionDigest?: string,
  ) => Effect.Effect<"claimed" | "same-fence" | "fenced" | "missing", HostedExecutionOperationsError>
  readonly appendFrame: (
    assignmentId: string,
    frame: ToolOperationLifecycleFrameValue,
  ) => Effect.Effect<AppendFrameResult, HostedExecutionOperationsError>
  readonly readFrames: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
  ) => Effect.Effect<ReadonlyArray<ToolOperationLifecycleFrameValue>, HostedExecutionOperationsError>
  readonly terminalFrame: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
  ) => Effect.Effect<
    Extract<ToolOperationLifecycleFrameValue, { readonly _tag: "Terminal" }> | undefined,
    HostedExecutionOperationsError
  >
  readonly terminalRecoveryScan: Effect.Effect<
    ReadonlyArray<{
      readonly assignmentId: string
      readonly operationKey: string
      readonly attempt: number
      readonly frame: Extract<ToolOperationLifecycleFrameValue, { readonly _tag: "Terminal" }>
    }>,
    HostedExecutionOperationsError
  >
  readonly replayQueue: (
    assignmentId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly operationKey: string; readonly attempt: number; readonly afterCursor: number }>,
    HostedExecutionOperationsError
  >
  readonly complete: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
    fence: Omit<DispatchFence, "providerInstanceId">,
    response: ToolOperationResponseValue,
    outcome: ToolOperationTerminalOutcomeValue,
  ) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly finalizeOperation: (
    input: FinalizeOperationInput,
  ) => Effect.Effect<FinalizeOperationResult, HostedExecutionOperationsError>
  readonly terminalizeAccepted: (
    key: Pick<OperationIdentity, "assignmentId" | "operationKey" | "attempt">,
    response: ToolOperationResponseValue,
    outcome: "failed" | "cancelled",
    onTerminalize?: (result: {
      readonly operation: OperationRecord
      readonly commandSequence: number
      readonly assignmentGeneration: number
      readonly leaseEpoch: number
    }) => Effect.Effect<void, HostedExecutionOperationsError>,
  ) => Effect.Effect<
    | {
        readonly operation: OperationRecord
        readonly commandSequence: number
        readonly assignmentGeneration: number
        readonly leaseEpoch: number
      }
    | undefined,
    HostedExecutionOperationsError
  >
  readonly admitWorkspaceCapabilities: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly assignmentId: string
    readonly workspaceId: string
    readonly assignmentGeneration: number
    readonly environmentDigest: string
    readonly requiredCapabilities: Schema.Json
  }) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly validateWorkspaceCapabilities: (input: {
    readonly threadId: string
    readonly turnId: string
    readonly assignmentId: string
    readonly workspaceId: string
    readonly assignmentGeneration: number
    readonly environmentDigest: string
  }) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly verifyRunnerAuthority: (input: {
    readonly ownerId: string
    readonly clientId: string
    readonly deviceId: string
    readonly userId: string
    readonly dpopJkt?: string
  }) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly runnerPrincipal: (input: {
    readonly assignmentId: string
    readonly generation: number
    readonly deviceId: string
    readonly processIncarnation: string
  }) => Effect.Effect<
    { readonly deviceId: string; readonly clientId: string; readonly userId: string } | undefined,
    HostedExecutionOperationsError
  >
  readonly hasConsumedRunnerAdmission: (input: {
    readonly assignmentId: string
    readonly ownerId: string
    readonly generation: number
    readonly deviceId: string
    readonly clientId: string
  }) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly lockRemoteCreationAdmission: (
    deviceId: string,
    checkoutFingerprint: string,
  ) => Effect.Effect<boolean, HostedExecutionOperationsError>
  readonly createRunnerAdmission: (input: {
    readonly id: string
    readonly assignmentId: string
    readonly ownerId: string
    readonly deviceId: string
    readonly clientId: string
    readonly userId: string
    readonly generation: number
    readonly workspaceFingerprint: string
    readonly ticketDigest: string
    readonly lifetimeMillis: number
  }) => Effect.Effect<number, HostedExecutionOperationsError>
  readonly lockRunnerAdmission: (
    id: string,
  ) => Effect.Effect<typeof rikaHostedRunnerAdmissions.$inferSelect | undefined, HostedExecutionOperationsError>
  readonly consumeRunnerAdmission: (
    id: string,
    processIncarnation: string,
  ) => Effect.Effect<boolean, HostedExecutionOperationsError>
}
