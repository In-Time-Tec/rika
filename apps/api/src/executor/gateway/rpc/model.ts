import type {
  AccessWire,
  BindingOutcome,
  BranchPushOutcome,
  MachineOutcome,
  MachineRequest,
  WorkspaceRequest,
  WorkspaceResponse,
} from "@rika/remote-execution/protocol"
import type { Deferred, Ref, Semaphore } from "effect"
import type { BindingAuthority, ExecuteInput, ExecutionResult, GatewayError, Socket } from "../contract"

export interface GatewaySession {
  readonly socket: Socket
  readonly access: AccessWire
  readonly leaseExpiresAt: number
  readonly ready: boolean
  readonly environmentDigest: string | null
}

export interface BindingCall {
  readonly requestDigest: string
  readonly result: Deferred.Deferred<BindingOutcome>
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
  readonly bindings: BindingAuthority
  readonly bindingCalls: Ref.Ref<Map<string, BindingCall>>
  readonly bindingAccess: Semaphore.Semaphore
  readonly nextMachineOrdinal: Ref.Ref<number>
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
