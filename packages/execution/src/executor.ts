/* oxlint-disable effecttsgo/missing-pipeable-signature -- protocol boundary predicates and validators are binary contracts. */
import { Context, Effect, Layer, Schema } from "effect"

import { WorkspaceBinding, WorkspaceBindingEvidence, bindingMismatchReason, sameEvidence, toEvidence } from "./binding"
import type { CanonicalResult, ExecutorCancellation, NativeOperationIntent } from "./operation"

export const maxHandshakeBytes = 16_384
export const maxDispatchBytes = 65_536
export const maxReceiptBytes = 131_072

export const HandshakeRequest = Schema.Struct({
  binding: WorkspaceBinding,
})
export type HandshakeRequest = typeof HandshakeRequest.Type

export const HandshakeEvidence = WorkspaceBindingEvidence
export type HandshakeEvidence = typeof HandshakeEvidence.Type

export const ExecutorEvidenceSource = Schema.Literals(["dispatch", "reconnect-cache"])
export type ExecutorEvidenceSource = typeof ExecutorEvidenceSource.Type

export const ExecutorEvidence = Schema.Struct({
  operationId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  inputDigest: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  binding: WorkspaceBindingEvidence,
  source: ExecutorEvidenceSource,
  outcome: Schema.Union([
    Schema.TaggedStruct("Accepted", {}),
    Schema.TaggedStruct("Completed", { result: Schema.Json }),
    Schema.TaggedStruct("DomainFailure", { failure: Schema.Json }),
    Schema.TaggedStruct("Unknown", { reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)) }),
  ]),
})
export type ExecutorEvidence = typeof ExecutorEvidence.Type

export const DispatchPhase = Schema.Literals([
  "handshake",
  "before-dispatch",
  "after-dispatch",
  "receipt",
  "cancel",
  "connection",
  "reconnect",
])
export type DispatchPhase = typeof DispatchPhase.Type

export class ExecutorTransportError extends Schema.TaggedError<ExecutorTransportError>()(
  "RikaExecutionV2ExecutorTransportError",
  {
    phase: DispatchPhase,
    message: Schema.String,
  },
) {}

export class ExecutorFenceError extends Schema.TaggedError<ExecutorFenceError>()("RikaExecutionV2ExecutorFenceError", {
  reason: Schema.Literals([
    "workspace",
    "assignment",
    "generation",
    "placement",
    "build",
    "protocol",
    "operation",
    "input",
  ]),
  message: Schema.String,
}) {}

export interface ExecutorBoundary {
  readonly handshake: (
    request: HandshakeRequest,
  ) => Effect.Effect<HandshakeEvidence, ExecutorTransportError | ExecutorFenceError>
  readonly dispatch: (
    intent: NativeOperationIntent,
    handshake: HandshakeEvidence,
  ) => Effect.Effect<ExecutorEvidence, ExecutorTransportError | ExecutorFenceError>
  readonly receipt: (
    operationId: string,
  ) => Effect.Effect<ExecutorEvidence | undefined, ExecutorTransportError | ExecutorFenceError>
}

export interface WorkspaceExecutorService {
  readonly binding: WorkspaceBinding
  readonly handshake: ExecutorBoundary["handshake"]
  readonly dispatch: (
    intent: NativeOperationIntent,
    input: Schema.Json,
    handshake: HandshakeEvidence,
  ) => Effect.Effect<ExecutorEvidence, ExecutorTransportError | ExecutorFenceError>
  readonly receipt: ExecutorBoundary["receipt"]
  readonly cancel: (
    operationId: string,
  ) => Effect.Effect<ExecutorCancellation, ExecutorTransportError | ExecutorFenceError>
}

export class WorkspaceExecutor extends Context.Service<WorkspaceExecutor, WorkspaceExecutorService>()(
  "@rika/execution/executor/WorkspaceExecutor",
) {}

export const workspaceExecutorLayer = (service: WorkspaceExecutorService): Layer.Layer<WorkspaceExecutor> =>
  Layer.succeed(WorkspaceExecutor, WorkspaceExecutor.of(service))

export class Executor extends Context.Service<Executor, ExecutorBoundary>()("@rika/execution/executor") {}

export const executorLayer = (boundary: ExecutorBoundary): Layer.Layer<Executor> =>
  Layer.succeed(Executor, Executor.of(boundary))

export const validateHandshake = (
  binding: WorkspaceBinding,
  evidence: HandshakeEvidence,
): Effect.Effect<HandshakeEvidence, ExecutorFenceError> =>
  sameEvidence(binding, evidence)
    ? Effect.succeed(evidence)
    : ExecutorFenceError.make({
        reason: bindingMismatchReason(binding, evidence) ?? "generation",
        message: "Executor handshake does not match the admitted binding",
      })

export const validateEvidence = (
  intent: NativeOperationIntent,
  evidence: ExecutorEvidence,
): Effect.Effect<ExecutorEvidence, ExecutorFenceError> => {
  if (evidence.operationId !== intent.operationId)
    return ExecutorFenceError.make({
      reason: "operation",
      message: "Executor evidence has a different operation identity",
    })
  if (evidence.inputDigest !== intent.inputDigest)
    return ExecutorFenceError.make({ reason: "input", message: "Executor evidence has a different input digest" })
  if (!sameEvidence(intent.binding, evidence.binding))
    return ExecutorFenceError.make({
      reason: bindingMismatchReason(intent.binding, evidence.binding) ?? "generation",
      message: "Executor evidence has a stale workspace fence",
    })
  return Effect.succeed(evidence)
}

export const handshakeFor = (binding: WorkspaceBinding): HandshakeRequest => ({ binding })

export const evidenceFor = (
  intent: NativeOperationIntent,
  outcome: ExecutorEvidence["outcome"],
  source: ExecutorEvidenceSource = "dispatch",
): ExecutorEvidence => ({
  operationId: intent.operationId,
  inputDigest: intent.inputDigest,
  binding: toEvidence(intent.binding),
  source,
  outcome,
})

export const ExecutorContract = {
  ExecutorEvidence,
  ExecutorEvidenceSource,
  ExecutorFenceError,
  ExecutorTransportError,
  HandshakeEvidence,
  HandshakeRequest,
  maxDispatchBytes,
  maxHandshakeBytes,
  maxReceiptBytes,
  validateEvidence,
  validateHandshake,
  WorkspaceExecutor,
}

export type AcceptedExecutorOutcome = Extract<CanonicalResult, { readonly _tag: "Accepted" }>
