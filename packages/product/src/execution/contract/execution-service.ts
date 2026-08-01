import { Context, Effect, Schema } from "effect"
import type { ChildEvent, FanOutInput, FanOutInspection, InvokeChildInput } from "./execution-child-run"
import type { Event, EventPage, ExecutionCheckpoint, Result } from "./execution-event"
import type { ExecutionReference, InvocationSource, OpenRootExecution, TurnPromoter } from "./execution-identifier"
import type { PendingApproval } from "./execution-approval"
import type { Inspection } from "./execution-inspection"
import type { EventScope, StartInput } from "./execution-request"
import type { WorkflowInspection } from "./execution-workflow"
export class BackendError extends Schema.TaggedErrorClass<BackendError>()("ExecutionBackendError", {
  message: Schema.String,
}) {}

export interface ThreadQueueWake {
  readonly threadId: string
  readonly generation: number
  readonly queueRevision: number
  readonly now: number
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

export interface SteerReceipt {
  readonly steeringMessageId: string
  readonly sequence: number
}

export class Service extends Context.Service<Service, Interface>()(
  "@rika/product/execution/contract/execution-service/Service",
) {}
