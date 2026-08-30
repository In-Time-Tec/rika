import type { Quiescence } from "@rika/e2b-executor/controller"
import type * as ExecutorRuntime from "@rika/kernel/executor-runtime"
import type * as MachineBindings from "@rika/kernel/machine-bindings"
import type {
  AccessWire,
  BindingManifest,
  BranchPushOutcome,
  CellLifecycleFrame,
  CellResponse,
  ExecutorMessage,
  PtyCreate,
  PtyInput,
  PtyReconnect,
  PtyResize,
  WorkspacePreparationEvidenceWire,
  WorkspacePreparationPhase,
  WorkspaceRequest,
  WorkspaceResponse,
} from "@rika/remote-execution/protocol"
import { Context, Effect, Redacted, Schema, Stream } from "effect"
import { HostBindingRegistry } from "tenetkit/repl"
import type { EnvironmentPhase } from "@rika/product/environment-policy"

export interface Socket {
  readonly send: (message: string) => void
  readonly close: (code?: number, reason?: string) => void
  readonly getBufferedAmount?: () => number
}

export type SocketFrame = string | Uint8Array<ArrayBufferLike>

export interface ExecutionResult {
  readonly access?: AccessWire
  readonly response: CellResponse
  readonly outcome: ExecutionOutcome
}

export type ExecutionOutcome = "completed" | "failed" | "cancelled" | "unknown"

export type LifecycleAppendDisposition =
  | { readonly _tag: "Appended" }
  | { readonly _tag: "AlreadyAppended" }
  | { readonly _tag: "AlreadyTerminal"; readonly result: ExecutionResult }

export type DeadlineResolution =
  | { readonly _tag: "Resolved"; readonly result: ExecutionResult }
  | { readonly _tag: "AlreadyTerminal"; readonly result: ExecutionResult }

export type PtyRequest =
  | { readonly _tag: "PtyCreate"; readonly request: PtyCreate }
  | { readonly _tag: "PtyInput"; readonly request: PtyInput }
  | { readonly _tag: "PtyResize"; readonly request: PtyResize }
  | { readonly _tag: "PtyDisconnect"; readonly ptyId: string }
  | { readonly _tag: "PtyReconnect"; readonly request: PtyReconnect }
  | { readonly _tag: "PtyTerminate"; readonly ptyId: string }

export type PtyEvent = Extract<
  ExecutorMessage,
  {
    readonly _tag: "PtyOpened" | "PtyOutput" | "PtyReplayGap" | "PtyDisconnected" | "PtyTerminated"
  }
>

export interface BranchPushInput {
  readonly assignmentId: string
  readonly publicationId: string
  readonly ownerId: string
  readonly repositoryId: string
  readonly workspaceId: string
  readonly branch: string
  readonly ref: string
  readonly commitSha: string
}

export interface BindingAuthority {
  readonly registry: HostBindingRegistry.Interface
  readonly context: Context.Context<ExecutorRuntime.CellServices>
  readonly manifest: BindingManifest
}

export class GatewayError extends Schema.TaggedError<GatewayError>()("ExecutorGatewayError", {
  kind: Schema.Literals(["disconnected", "fenced", "timeout", "transport"]),
  message: Schema.String,
}) {}

export interface OperationIdentity {
  readonly assignmentId: string
  readonly operationKey: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly threadId: string
  readonly turnId: string
  readonly runId: string
  readonly toolCallId: string
  readonly code: string
  readonly rootRunId: string
  readonly attempt: number
  readonly replayPolicy: "pure" | "provider-idempotent" | "never"
}

export interface OperationInput extends OperationIdentity {
  readonly admittedAt: string | null
  readonly deadlineAt: string
}

export interface ExecutorDataPlane {
  readonly receive: (socket: Socket, frame: SocketFrame) => Effect.Effect<void>
  readonly disconnected: (socket: Socket) => Effect.Effect<void>
  readonly active: (socket: Socket) => Effect.Effect<boolean>
  readonly cancel: (input: OperationIdentity) => Effect.Effect<ExecutionResult, GatewayError>
  readonly machine: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
    request: MachineBindings.Request,
  ) => Effect.Effect<MachineBindings.Outcome, GatewayError>
}

export interface ExecuteInput extends OperationInput {
  readonly bindings: BindingAuthority
}

export interface Gateway extends ExecutorDataPlane {
  readonly execute: (input: ExecuteInput) => Effect.Effect<ExecutionResult, GatewayError>
  readonly sendPty: (assignmentId: string, request: PtyRequest) => Effect.Effect<void, GatewayError>
  readonly ptyEvents: (assignmentId: string) => Stream.Stream<PtyEvent>
  readonly retryPreparation: (assignmentId: string) => Effect.Effect<void, GatewayError>
  readonly workspace: (
    assignmentId: string,
    request: WorkspaceRequest,
  ) => Effect.Effect<WorkspaceResponse, GatewayError>
  readonly quiesce: (assignmentId: string) => Effect.Effect<Quiescence, GatewayError>
  readonly pushBranch: (input: BranchPushInput) => Effect.Effect<BranchPushOutcome, GatewayError>
}

export interface LifecycleStore {
  readonly append: (
    access: AccessWire,
    frame: CellLifecycleFrame,
  ) => Effect.Effect<LifecycleAppendDisposition, GatewayError>
  readonly load: (
    assignmentId: string,
    operationKey: string,
    attempt: number,
  ) => Effect.Effect<ReadonlyArray<CellLifecycleFrame>, GatewayError>
  readonly replay: (assignmentId: string) => Effect.Effect<
    ReadonlyArray<{
      readonly operationKey: string
      readonly attempt: number
      readonly afterCursor: number
    }>,
    GatewayError
  >
  readonly prepare: (input: OperationInput) => Effect.Effect<
    {
      readonly admittedAt: string | null
      readonly deadlineAt: string
    },
    GatewayError
  >
  readonly inspect: (input: OperationIdentity) => Effect.Effect<
    {
      readonly state: "accepted" | "dispatched" | "completed" | "unknown"
      readonly started: boolean
      readonly response?: CellResponse
      readonly dispatchedGeneration?: number
      readonly dispatchedExecutorInstanceId?: string
      readonly dispatchedProcessIncarnation?: string
      readonly outcome?: ExecutionOutcome
    },
    GatewayError
  >
  readonly dispatch: (input: OperationInput, access: AccessWire) => Effect.Effect<void, GatewayError>
  readonly cancel: (
    input: OperationIdentity,
  ) => Effect.Effect<
    | { readonly _tag: "Cancelled"; readonly result: ExecutionResult }
    | { readonly _tag: "Dispatched" }
    | { readonly _tag: "AlreadyTerminal"; readonly result: ExecutionResult },
    GatewayError
  >
  readonly resolveDeadline: (input: OperationInput) => Effect.Effect<DeadlineResolution, GatewayError>
}

export interface PhaseEnvironmentGrant {
  readonly digest: string
  readonly values: Readonly<Record<string, Redacted.Redacted<string>>>
  readonly redactedNames: ReadonlyArray<string>
}

export interface PhaseAuthority {
  readonly activate: <A, R>(
    access: AccessWire,
    phase: EnvironmentPhase,
    use: (grant: PhaseEnvironmentGrant) => Effect.Effect<A, GatewayError, R>,
  ) => Effect.Effect<A, GatewayError, R>
  readonly publication: <A, R>(
    access: AccessWire,
    use: () => Effect.Effect<A, GatewayError, R>,
  ) => Effect.Effect<A, GatewayError, R>
  readonly replace: (key: {
    readonly assignmentId: string
    readonly generation: number
  }) => Effect.Effect<void, GatewayError>
}

export interface PreparationStore {
  readonly start: (input: {
    readonly access: AccessWire
    readonly workspaceId: string
    readonly phase: WorkspacePreparationPhase
    readonly attempt: number
  }) => Effect.Effect<void, GatewayError>
  readonly output: (input: {
    readonly access: AccessWire
    readonly workspaceId: string
    readonly phase: WorkspacePreparationPhase
    readonly attempt: number
    readonly stream: "stdout" | "stderr"
    readonly text: string
    readonly redacted: true
    readonly truncated: boolean
  }) => Effect.Effect<void, GatewayError>
  readonly complete: (input: {
    readonly access: AccessWire
    readonly workspaceId: string
    readonly phase: WorkspacePreparationPhase
    readonly attempt: number
    readonly evidence: WorkspacePreparationEvidenceWire
  }) => Effect.Effect<void, GatewayError>
  readonly fail: (input: {
    readonly access: AccessWire
    readonly workspaceId: string
    readonly phase: WorkspacePreparationPhase
    readonly attempt: number
    readonly message: string
    readonly retryable: boolean
  }) => Effect.Effect<void, GatewayError>
  readonly retry: (access: AccessWire) => Effect.Effect<number, GatewayError>
  readonly ready: (access: AccessWire) => Effect.Effect<void, GatewayError>
}

export const cancelledResponse: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "cancelled", message: "Cell operation cancelled" },
}
