import type { ControllerError } from "@rika/e2b-executor/controller"
import {
  ApiMessage,
  ExecutorMessage,
  MachineRequest,
  WorkspaceRequest,
  type AccessWire,
  type ExecutorMessage as ExecutorMessageValue,
  type Fence,
  type WorkspaceRequest as WorkspaceRequestValue,
  type WorkspaceResponse,
} from "@rika/remote-execution/protocol"
import { Schema } from "effect"
import { GatewayError } from "./contract"

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutorMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ApiMessage))
const key = (assignmentId: string, operationKey: string, attempt: number) =>
  `${assignmentId}\u0000${operationKey}\u0000${attempt}`
const workspaceKey = (assignmentId: string, requestId: string) => `${assignmentId}\u0000${requestId}`
const encodeMachineRequest = Schema.encodeSync(Schema.fromJsonString(MachineRequest))
const equivalentWorkspaceRequest = Schema.toEquivalence(WorkspaceRequest)

const matchesWorkspaceRequest = (request: WorkspaceRequestValue, response: WorkspaceResponse) => {
  if (request.requestId !== response.requestId) return false
  if (request._tag === "WorkspaceFileInspect")
    return (
      (response._tag === "WorkspaceFileContent" || response._tag === "WorkspaceFileRejected") &&
      request.path === response.path
    )
  return (
    (response._tag === "RepositoryServiceRunning" ||
      response._tag === "RepositoryServiceStopped" ||
      response._tag === "RepositoryServiceRejected") &&
    (request._tag === "RepositoryServiceEnsure" ? request.service.serviceId : request.serviceId) === response.serviceId
  )
}

const sameAccess = (left: AccessWire, right: AccessWire) =>
  left.leaseEpoch === right.leaseEpoch &&
  left.sessionToken === right.sessionToken &&
  left.fence.target === right.fence.target &&
  left.fence.assignmentId === right.fence.assignmentId &&
  left.fence.assignmentGeneration === right.fence.assignmentGeneration &&
  left.fence.instanceId === right.fence.instanceId &&
  left.fence.executorId === right.fence.executorId &&
  left.fence.processIncarnation === right.fence.processIncarnation

const sameExecutor = (left: AccessWire, right: AccessWire) =>
  left.sessionToken === right.sessionToken &&
  left.fence.target === right.fence.target &&
  left.fence.assignmentId === right.fence.assignmentId &&
  left.fence.assignmentGeneration === right.fence.assignmentGeneration &&
  left.fence.instanceId === right.fence.instanceId &&
  left.fence.executorId === right.fence.executorId &&
  left.fence.processIncarnation === right.fence.processIncarnation

const accessFailure = (error: ControllerError) =>
  GatewayError.make({
    kind: error.kind === "fenced" || error.kind === "lease-expired" ? "fenced" : "transport",
    message: error.message,
  })

const expired = () => GatewayError.make({ kind: "fenced", message: "Executor lease expired before work could be sent" })

const fenceOf = (message: ExecutorMessageValue): Fence | undefined => {
  if (message._tag === "ExecutorHello") return message.hello.fence
  if (message._tag === "ExecutorHeartbeat") return message.heartbeat.access.fence
  return message.access.fence
}

export const gatewayProtocol = {
  accessFailure,
  decode,
  encode,
  encodeMachineRequest,
  equivalentWorkspaceRequest,
  expired,
  fenceOf,
  key,
  matchesWorkspaceRequest,
  sameAccess,
  sameExecutor,
  workspaceKey,
}
