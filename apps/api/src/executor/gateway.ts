import type { Interface as Controller } from "@rika/e2b-executor/controller"
import { Context, Effect, Layer } from "effect"
import type { HostedToolPolicyService } from "../hosted/execution/tool-policy"
import type { Gateway, GatewayError, LifecycleStore, PhaseAuthority, PreparationStore } from "./gateway-contract"
import { gatewayRuntime } from "./gateway-runtime"

export class ExecutorGateway extends Context.Service<ExecutorGateway, Gateway>()(
  "@rika/api/executor/gateway/ExecutorGateway",
) {}

export const gatewayLayer = (options: {
  readonly controller: Controller
  readonly lifecycle: LifecycleStore
  readonly phases: PhaseAuthority
  readonly preparation: PreparationStore
  readonly bindingContract: (workspaceId: string) => Effect.Effect<string, GatewayError>
  readonly toolPolicy: HostedToolPolicyService
}) =>
  Layer.effect(
    ExecutorGateway,
    gatewayRuntime.makeGateway(
      options.controller,
      options.lifecycle,
      options.phases,
      options.preparation,
      options.bindingContract,
      options.toolPolicy,
    ),
  )

export { GatewayError } from "./gateway-contract"
export type {
  BindingAuthority,
  BranchPushInput,
  DeadlineResolution,
  ExecuteInput,
  ExecutionOutcome,
  ExecutionResult,
  ExecutorDataPlane,
  Gateway,
  LifecycleAppendDisposition,
  LifecycleStore,
  OperationIdentity,
  OperationInput,
  PhaseAuthority,
  PhaseEnvironmentGrant,
  PreparationStore,
  PtyEvent,
  PtyRequest,
  Socket,
  SocketFrame,
} from "./gateway-contract"
export { cancelledResponse } from "./gateway-protocol"
export { makeGateway } from "./gateway-runtime"
