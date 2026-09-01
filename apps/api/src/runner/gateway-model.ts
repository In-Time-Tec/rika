import type { FinalizeOperationInput } from "@rika/product-store/executor-operations"
import type { ToolOperationResponse } from "@rika/product/tool-operation-lifecycle"
import {
  ApiMessage,
  MachineRequest,
  RunnerMessage,
  type AccessWire,
  type MachineOutcome,
} from "@rika/remote-execution/protocol"
import { Deferred, Schema } from "effect"
import { GatewayError, type OperationInput, type Socket } from "../executor/gateway"

export interface Session {
  readonly socket: Socket
  readonly access: AccessWire
  readonly leaseExpiresAt: number
}

export interface FinalResult {
  readonly access?: AccessWire
  readonly response: ToolOperationResponse
  readonly outcome: ExecutionOutcome
  readonly eventPersisted: boolean
}

export type ExecutionOutcome = "completed" | "failed" | "cancelled" | "unknown"

export interface LocalExecuteInput extends OperationInput {
  readonly machineRequest: MachineRequest
}

export interface Pending {
  readonly assignmentId: string
  readonly operationKey: string
  readonly attempt: number
  readonly code: string
  readonly workspaceId: string
  readonly request: LocalExecuteInput
  readonly socket: Socket
  readonly access: AccessWire
  readonly result: Deferred.Deferred<FinalResult, GatewayError>
}

export interface MachineCall {
  readonly assignmentId: string
  readonly operationKey: string
  readonly attempt: number
  readonly machineId: string
  readonly requestDigest: string
  readonly request: MachineRequest
  readonly socket: Socket
  readonly access: AccessWire
  readonly deadlineAtMillis: number
  readonly cancelling: boolean
  readonly result: Deferred.Deferred<MachineOutcome>
}

export type MutableFinalizeOperationInput = {
  -readonly [Key in keyof FinalizeOperationInput]: FinalizeOperationInput[Key]
}

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ApiMessage))

const OperationIdentitySchema = Schema.Struct({
  workspaceId: Schema.String,
  sessionId: Schema.String,
  threadId: Schema.String,
  turnId: Schema.String,
  runId: Schema.String,
  rootRunId: Schema.String,
  toolCallId: Schema.String,
  code: Schema.String,
  attempt: Schema.Int,
  replayPolicy: Schema.Literals(["pure", "provider-idempotent", "never"]),
})

const encodeOperationIdentity = Schema.encodeSync(Schema.fromJsonString(OperationIdentitySchema))
const encodeMachineRequest = Schema.encodeSync(Schema.fromJsonString(MachineRequest))

const operationKey = (assignmentId: string, key: string, attempt: number) =>
  `${assignmentId}\u001f${key}\u001f${attempt}`

const machineKey = (assignmentId: string, key: string, attempt: number, machineId: string) =>
  `${assignmentId}\u001f${key}\u001f${attempt}\u001f${machineId}`

const failure = (kind: GatewayError["kind"], message: string): GatewayError => GatewayError.make({ kind, message })

const finalResult = (response: ToolOperationResponse, outcome: ExecutionOutcome, access?: AccessWire): FinalResult => {
  const result: FinalResult = { response, outcome, eventPersisted: true }
  return access === undefined ? result : { ...result, access }
}

const sameFence = (left: AccessWire, right: AccessWire) =>
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  left.fence.assignmentId === right.fence.assignmentId &&
  left.fence.assignmentGeneration === right.fence.assignmentGeneration &&
  left.fence.target === right.fence.target &&
  left.fence.instanceId === right.fence.instanceId &&
  left.fence.executorId === right.fence.executorId &&
  left.fence.processIncarnation === right.fence.processIncarnation

const unknownResponse: ToolOperationResponse = {
  _tag: "DomainFailure",
  failure: { kind: "unknown", message: "Local tool outcome is unknown after executor disconnect" },
}

const timeoutResponse: ToolOperationResponse = {
  _tag: "DomainFailure",
  failure: { kind: "timeout", message: "Tool operation deadline exceeded" },
}

export const gatewayModel = {
  decode,
  encode,
  encodeMachineRequest,
  encodeOperationIdentity,
  failure,
  finalResult,
  machineKey,
  operationKey,
  sameFence,
  timeoutResponse,
  unknownResponse,
}
