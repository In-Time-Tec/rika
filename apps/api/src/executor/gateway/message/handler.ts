import { redactAccess, type ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect } from "effect"
import type { Socket } from "../contract"
import {
  gatewayCredentialMessageHandler,
  isGatewayCredentialMessage,
  type GatewayCredentialMessageDependencies,
} from "./credential/core"
import { gatewayOperationMessageHandler, type GatewayOperationMessageDependencies } from "./operation"
import {
  gatewaySessionMessageHandler,
  isGatewaySessionMessage,
  type GatewaySessionMessageDependencies,
} from "./session/core"

type Dependencies = GatewaySessionMessageDependencies &
  GatewayCredentialMessageDependencies &
  GatewayOperationMessageDependencies

export const gatewayMessageHandlerFactory = (dependencies: Dependencies) => {
  const session = gatewaySessionMessageHandler(dependencies)
  const credential = gatewayCredentialMessageHandler(dependencies)
  const operation = gatewayOperationMessageHandler(dependencies)

  const handle = Effect.fn("ExecutorGateway.handle")(function* (socket: Socket, message: ExecutorMessage) {
    if (message._tag === "BranchPushResult") yield* dependencies.controller.validateAccess(redactAccess(message.access))
    if (isGatewaySessionMessage(message)) return yield* session(socket, message)
    if (isGatewayCredentialMessage(message)) return yield* credential(socket, message)
    return yield* operation(socket, message)
  })

  return { handle }
}
