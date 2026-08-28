import type { ControllerError } from "@rika/e2b-executor/controller"
import {
  ApiMessage,
  BindingRequest,
  CellLifecycleFrame as CellLifecycleFrameSchema,
  CellResponse as CellResponseSchema,
  ExecutorMessage,
  MachineRequest,
  WorkspaceRequest,
  type AccessWire,
  type CellResponse,
  type ExecutorMessage as ExecutorMessageValue,
  type Fence,
  type WorkspaceRequest as WorkspaceRequestValue,
  type WorkspaceResponse,
} from "@rika/remote-execution/protocol"
import { Schema } from "effect"
import { GatewayError, type Socket } from "./gateway-contract"

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(ExecutorMessage))
const encode = Schema.encodeSync(Schema.fromJsonString(ApiMessage))
const equivalentLifecycle = Schema.toEquivalence(CellLifecycleFrameSchema)
const equivalentResponse = Schema.toEquivalence(CellResponseSchema)
const key = (assignmentId: string, operationKey: string, attempt: number) =>
  `${assignmentId}\u0000${operationKey}\u0000${attempt}`
const machineKey = (assignmentId: string, operationKey: string, attempt: number, machineId: string) =>
  `${assignmentId}\u0000${operationKey}\u0000${attempt}\u0000${machineId}`
const workspaceKey = (assignmentId: string, requestId: string) => `${assignmentId}\u0000${requestId}`
const encodeBindingRequest = Schema.encodeSync(Schema.fromJsonString(BindingRequest))
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

export const cancelledResponse: CellResponse = {
  _tag: "DomainFailure",
  failure: { kind: "cancelled", message: "Cell operation cancelled" },
}

const fenceOf = (message: ExecutorMessageValue): Fence | undefined => {
  switch (message._tag) {
    case "ExecutorHello":
      return message.hello.fence
    case "ExecutorReconnect":
      return message.access.fence
    case "ExecutorHeartbeat":
      return message.heartbeat.access.fence
    case "ExecutorConnectionFailed":
    case "CredentialRequested":
    case "CredentialRevocationRequested":
    case "WorkspacePreparationRequested":
    case "WorkspacePreparationStarted":
    case "WorkspacePreparationOutput":
    case "WorkspacePreparationReady":
    case "WorkspacePreparationFailed":
    case "ExecutorWorkspaceReady":
    case "ExecutorQuiesced":
    case "SetupCacheLookup":
    case "SetupCacheProposed":
    case "PtyOpened":
    case "PtyOutput":
    case "PtyReplayGap":
    case "PtyDisconnected":
    case "PtyTerminated":
    case "WorkspaceResponse":
    case "CellLifecycle":
    case "BindingInvoke":
    case "MachineResult":
    case "BranchPushResult":
      return message.access.fence
    case "CellResult":
      return message.access.fence
  }
}

const close = (socket: Socket, code: number, reason: string) => {
  socket.close(code, reason)
}

const failure = (socket: Socket, message: ExecutorMessageValue, error: ControllerError | GatewayError) => {
  const fence = fenceOf(message)
  if (fence !== undefined) socket.send(encode({ _tag: "Fenced", fence, message: error.message }))
  close(socket, 1008, error.kind)
}

export const gatewayProtocol = {
  decode,
  encode,
  equivalentLifecycle,
  equivalentResponse,
  key,
  machineKey,
  workspaceKey,
  encodeBindingRequest,
  encodeMachineRequest,
  equivalentWorkspaceRequest,
  matchesWorkspaceRequest,
  sameAccess,
  sameExecutor,
  accessFailure,
  expired,
  fenceOf,
  close,
  failure,
}
