import { Effect, Function, Schema } from "effect"
import type { OutputChunk } from "./cells"
import {
  CellAttribution,
  CellLifecycleFrame,
  CellResponse,
  type AccessWire,
  type ApiMessage,
  type CellRequest,
  type MachineOutcome,
  type MachineRequest,
} from "./messages"

export class OperationError extends Schema.TaggedError<OperationError>()("OperationError", {
  kind: Schema.Literals(["authorization", "execution", "fenced", "persistence", "transport", "workspace"]),
  message: Schema.String,
}) {}

export const OperationReceipt = Schema.Struct({
  operationKey: Schema.String.check(Schema.isMinLength(1)),
  frames: Schema.NonEmptyArray(CellLifecycleFrame),
})
export type OperationReceipt = typeof OperationReceipt.Type

export type ReceiptMap = Map<string, ReadonlyArray<CellLifecycleFrame>>

export type Command = Extract<
  ApiMessage,
  {
    readonly _tag:
      | "CellCancel"
      | "CellExecute"
      | "CellReplay"
      | "CellTerminalReceipt"
      | "CellTerminalSuperseded"
      | "LocalCellReceipt"
      | "MachineExecute"
  }
>

export type Event =
  | { readonly _tag: "CellLifecycle"; readonly access: AccessWire; readonly frame: CellLifecycleFrame }
  | {
      readonly _tag: "CellResult"
      readonly access: AccessWire
      readonly operationKey: string
      readonly attempt: number
      readonly response: CellResponse
    }
  | {
      readonly _tag: "MachineResult"
      readonly access: AccessWire
      readonly operationKey: string
      readonly attempt: number
      readonly machineId: string
      readonly requestDigest: string
      readonly outcome: MachineOutcome
    }

export interface PreparedCell {
  readonly secrets: ReadonlyArray<string>
  readonly execute: (output: (chunk: OutputChunk) => Effect.Effect<void>) => Effect.Effect<CellResponse, OperationError>
}

export interface Options {
  readonly access: Effect.Effect<AccessWire, OperationError>
  readonly receipts: {
    readonly current: Effect.Effect<ReceiptMap>
    readonly commit: (receipts: ReceiptMap) => Effect.Effect<void, OperationError>
  }
  readonly emit: (event: Event) => Effect.Effect<void, OperationError>
  readonly cell: {
    readonly prepare: (request: CellRequest) => Effect.Effect<PreparedCell, OperationError>
    readonly admit: (request: CellRequest) => Effect.Effect<void, OperationError>
    readonly cancel: (operationKey: string, attempt: number) => Effect.Effect<CellResponse, OperationError>
    readonly replayBindings: (access: AccessWire) => Effect.Effect<void, OperationError>
  }
  readonly machine: {
    readonly execute: (input: {
      readonly machineId: string
      readonly requestDigest: string
      readonly request: MachineRequest
    }) => Effect.Effect<MachineOutcome, OperationError>
  }
}

export interface Interface {
  readonly dispatch: (command: Command) => Effect.Effect<void, OperationError>
  readonly receipts: Effect.Effect<ReceiptMap>
  readonly terminalizeOpen: (response: CellResponse) => Effect.Effect<
    ReadonlyArray<{
      readonly operationKey: string
      readonly outcome: "completed" | "failed" | "cancelled" | "unknown"
    }>,
    OperationError
  >
}

export const OutputLimit = 16
const OutputTextLimit = 16_384

export const executionKey: {
  (operationKey: string, attempt: number): string
  (attempt: number): (operationKey: string) => string
} = Function.dual(2, (operationKey: string, attempt: number) => `${operationKey}\u0000${attempt}`)
export const machineExecutionKey: {
  (operationKey: string, attempt: number, machineId: string): string
  (attempt: number, machineId: string): (operationKey: string) => string
} = Function.dual(
  3,
  (operationKey: string, attempt: number, machineId: string) =>
    `${executionKey(operationKey, attempt)}\u0000${machineId}`,
)

const sameFence = (left: AccessWire["fence"], right: AccessWire["fence"]) =>
  left.target === right.target &&
  left.assignmentId === right.assignmentId &&
  left.assignmentGeneration === right.assignmentGeneration &&
  left.instanceId === right.instanceId &&
  left.executorId === right.executorId &&
  left.processIncarnation === right.processIncarnation

export const sameAccess: {
  (left: AccessWire, right: AccessWire): boolean
  (right: AccessWire): (left: AccessWire) => boolean
} = Function.dual(
  2,
  (left: AccessWire, right: AccessWire) =>
    left.version === right.version &&
    left.leaseEpoch === right.leaseEpoch &&
    left.sessionToken === right.sessionToken &&
    sameFence(left.fence, right.fence),
)

export const attribution = (request: CellRequest): CellAttribution => ({
  operationKey: request.operationKey,
  workspaceId: request.workspaceId,
  sessionId: request.sessionId,
  threadId: request.threadId,
  turnId: request.turnId,
  runId: request.runId,
  rootRunId: request.rootRunId,
  toolCallId: request.toolCallId,
  attempt: request.attempt,
})

export const sameAttribution: {
  (left: CellAttribution, right: CellAttribution): boolean
  (right: CellAttribution): (left: CellAttribution) => boolean
} = Function.dual(
  2,
  (left: CellAttribution, right: CellAttribution) =>
    left.operationKey === right.operationKey &&
    left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId &&
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.rootRunId === right.rootRunId &&
    left.toolCallId === right.toolCallId &&
    left.attempt === right.attempt,
)

export const accepted = (frames: ReadonlyArray<CellLifecycleFrame>) =>
  frames.find((frame): frame is Extract<CellLifecycleFrame, { readonly _tag: "Accepted" }> => frame._tag === "Accepted")

export const terminal = (frames: ReadonlyArray<CellLifecycleFrame>) =>
  frames.find((frame): frame is Extract<CellLifecycleFrame, { readonly _tag: "Terminal" }> => frame._tag === "Terminal")

const redactText = (value: string, secrets: ReadonlyArray<string>) =>
  secrets.reduce((text, secret) => (secret.length === 0 ? text : text.split(secret).join("REDACTED")), value)

const redactOutput: {
  (value: string, secrets: ReadonlyArray<string>): { readonly text: string; readonly truncated: boolean }
  (secrets: ReadonlyArray<string>): (value: string) => { readonly text: string; readonly truncated: boolean }
} = Function.dual(2, (value: string, secrets: ReadonlyArray<string>) => {
  const text = redactText(value, secrets)
    .replace(/(token|password|secret|authorization)["']?\s*[:=]\s*["'][^"']+/gi, "$1=REDACTED")
    .replace(/\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]+\b/g, "REDACTED")
  return { text: text.slice(0, OutputTextLimit), truncated: text.length > OutputTextLimit }
})

export const OutputRedaction = { apply: redactOutput }

export const redactResponse: {
  (response: CellResponse, secrets: ReadonlyArray<string>): CellResponse
  (secrets: ReadonlyArray<string>): (response: CellResponse) => CellResponse
} = Function.dual(2, (response: CellResponse, secrets: ReadonlyArray<string>): CellResponse => {
  if (secrets.length === 0) return response
  const encoded = Schema.encodeSync(Schema.fromJsonString(CellResponse))(response)
  return Schema.decodeSync(Schema.fromJsonString(CellResponse))(redactText(encoded, secrets))
})

export const cellFailure = (error: OperationError): CellResponse => ({
  _tag: "DomainFailure",
  failure: { kind: error.kind, message: error.message },
})

export const executionFailure: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "execution", message: "Cell execution failed" },
}
