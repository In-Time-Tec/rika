import { ApiMessage, MachineRequest, RunnerMessage, type AccessWire } from "@rika/remote-execution/protocol"
import { Schema } from "effect"
import type { ExecuteInput, ExecutionResult } from "../executor/gateway"
import type { GatewaySession } from "../executor/gateway/rpc/model"

export type Session = GatewaySession
export type LocalExecuteInput = ExecuteInput
export type FinalResult = ExecutionResult & { readonly eventPersisted: boolean }

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(RunnerMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ApiMessage))

const encodeMachineRequest = Schema.encodeSync(Schema.fromJsonString(MachineRequest))

const sameFence = (left: AccessWire, right: AccessWire) =>
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  left.fence.assignmentId === right.fence.assignmentId &&
  left.fence.assignmentGeneration === right.fence.assignmentGeneration &&
  left.fence.target === right.fence.target &&
  left.fence.instanceId === right.fence.instanceId &&
  left.fence.executorId === right.fence.executorId &&
  left.fence.processIncarnation === right.fence.processIncarnation

export const gatewayModel = {
  decode,
  encode,
  encodeMachineRequest,
  sameFence,
}
