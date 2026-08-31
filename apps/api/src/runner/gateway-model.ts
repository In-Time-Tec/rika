import type * as MachineBindings from "@rika/kernel/machine-bindings"
import type { FinalizeOperationInput } from "@rika/product-store/executor-operations"
import {
  ApiMessage,
  BindingRequest,
  MachineRequest,
  RunnerMessage,
  type AccessWire,
  type BindingOutcome,
  type CellResponse,
} from "@rika/remote-execution/protocol"
import { Deferred, Ref, Schema, Semaphore } from "effect"
import {
  GatewayError,
  type BindingAuthority,
  type ExecutionOutcome,
  type OperationInput,
  type Socket,
} from "../executor/gateway"

export interface Session {
  readonly socket: Socket
  readonly access: AccessWire
  readonly leaseExpiresAt: number
}

export interface FinalResult {
  readonly access?: AccessWire
  readonly response: CellResponse
  readonly outcome: ExecutionOutcome
  readonly eventPersisted: boolean
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
  readonly acknowledged: Deferred.Deferred<void>
  readonly bindings: BindingAuthority
  readonly bindingCalls: Ref.Ref<Map<string, BindingCall>>
  readonly bindingLock: Semaphore.Semaphore
  readonly nextMachineOrdinal: Ref.Ref<number>
}

export interface BindingCall {
  readonly requestDigest: string
  readonly result: Deferred.Deferred<BindingOutcome>
}

export interface MachineCall {
  readonly assignmentId: string
  readonly operationKey: string
  readonly attempt: number
  readonly machineId: string
  readonly requestDigest: string
  readonly request: MachineBindings.Request
  readonly socket: Socket
  readonly access: AccessWire
  readonly deadlineAtMillis: number
  readonly result: Deferred.Deferred<MachineBindings.Outcome>
}

export type LocalExecuteInput = OperationInput & {
  readonly bindings: BindingAuthority
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
const encodeBindingRequest = Schema.encodeSync(Schema.fromJsonString(BindingRequest))
const encodeMachineRequest = Schema.encodeSync(Schema.fromJsonString(MachineRequest))

const operationKey = (assignmentId: string, key: string, attempt: number) =>
  `${assignmentId}\u001f${key}\u001f${attempt}`

const machineKey = (assignmentId: string, key: string, attempt: number, machineId: string) =>
  `${assignmentId}\u001f${key}\u001f${attempt}\u001f${machineId}`

const failure = (kind: GatewayError["kind"], message: string): GatewayError => GatewayError.make({ kind, message })

const finalResult = (response: CellResponse, outcome: ExecutionOutcome, access?: AccessWire): FinalResult => {
  const result: FinalResult = { response, outcome, eventPersisted: true }
  if (access !== undefined) return { ...result, access }
  return result
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

const unknownResponse: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "unknown", message: "Local operation outcome is unknown after executor disconnect" },
}

const timeoutResponse: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "timeout", message: "Cell operation deadline exceeded" },
}

export const gatewayModel = {
  decode,
  encode,
  encodeBindingRequest,
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
