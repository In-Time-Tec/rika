import type { ControllerError, Interface as Controller } from "@rika/e2b-executor/controller"
import { redactAccess, type ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect } from "effect"
import type { GatewayError, Socket } from "../contract"

type Message = Extract<
  ExecutorMessage,
  {
    readonly _tag:
      | "MachineResult"
      | "WorkspaceResponse"
      | "BranchPushResult"
      | "PtyOpened"
      | "PtyOutput"
      | "PtyReplayGap"
      | "PtyDisconnected"
      | "PtyTerminated"
  }
>

export interface GatewayOperationMessageDependencies {
  readonly controller: Controller
  readonly receiveMachine: (
    socket: Socket,
    message: Extract<Message, { readonly _tag: "MachineResult" }>,
  ) => Effect.Effect<void, ControllerError | GatewayError>
  readonly receiveWorkspace: (
    socket: Socket,
    message: Extract<Message, { readonly _tag: "WorkspaceResponse" }>,
  ) => Effect.Effect<void, ControllerError | GatewayError>
  readonly receiveBranchPush: (
    socket: Socket,
    message: Extract<Message, { readonly _tag: "BranchPushResult" }>,
  ) => Effect.Effect<void, ControllerError | GatewayError>
  readonly publishPty: (
    socket: Socket,
    message: Extract<Message, { readonly _tag: `Pty${string}` }>,
  ) => Effect.Effect<void, ControllerError | GatewayError>
}

export const gatewayOperationMessageHandler = (dependencies: GatewayOperationMessageDependencies) =>
  Effect.fn("ExecutorGateway.handleOperationMessage")(function* (socket: Socket, message: Message) {
    switch (message._tag) {
      case "MachineResult":
        yield* dependencies.controller.validateAccess(redactAccess(message.access))
        yield* dependencies.receiveMachine(socket, message)
        return true
      case "WorkspaceResponse":
        yield* dependencies.receiveWorkspace(socket, message)
        return true
      case "BranchPushResult":
        yield* dependencies.receiveBranchPush(socket, message)
        return true
      case "PtyOpened":
      case "PtyOutput":
      case "PtyReplayGap":
      case "PtyDisconnected":
      case "PtyTerminated":
        yield* dependencies.publishPty(socket, message)
        return true
    }
  })
