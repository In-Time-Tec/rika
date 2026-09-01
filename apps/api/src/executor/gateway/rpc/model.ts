import type {
  AccessWire,
  BranchPushOutcome,
  MachineOutcome,
  MachineRequest,
  WorkspaceRequest,
  WorkspaceResponse,
} from "@rika/remote-execution/protocol"
import type { Deferred } from "effect"
import type { ExecuteInput, ExecutionResult, GatewayError, Socket } from "../contract"

export interface GatewaySession {
  readonly socket: Socket
  readonly access: AccessWire
  readonly leaseExpiresAt: number
  readonly ready: boolean
  readonly environmentDigest: string | null
}

export interface PendingOperation {
  readonly assignmentId: string
  readonly operationKey: string
  readonly attempt: number
  readonly request: ExecuteInput
  readonly socket: Socket
  readonly access: AccessWire
  readonly result: Deferred.Deferred<ExecutionResult, GatewayError>
  readonly waiters: number
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

export interface WorkspaceCall {
  readonly assignmentId: string
  readonly request: WorkspaceRequest
  readonly socket: Socket
  readonly access: AccessWire
  readonly result: Deferred.Deferred<WorkspaceResponse, GatewayError>
}

export interface BranchPushCall {
  readonly assignmentId: string
  readonly publicationId: string
  readonly ownerId: string
  readonly repositoryId: string
  readonly workspaceId: string
  readonly branch: string
  readonly ref: string
  readonly commitSha: string
  readonly socket: Socket
  readonly access: AccessWire
  readonly result: Deferred.Deferred<BranchPushOutcome, GatewayError>
}
