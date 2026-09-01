import type { Interface as Controller } from "@rika/e2b-executor/controller"
import type { ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect, Ref } from "effect"
import type { PreparationStore, Socket } from "../../contract"
import { gatewayCredentialPreparationHandler } from "./preparation"
import { gatewayCredentialRequestHandler } from "./request"
import { gatewayCredentialRevocationHandler } from "./revocation"
import { gatewayProtocol } from "../../protocol"
import type { BranchPushCall } from "../../rpc/model"

const messageTags = [
  "CredentialRequested",
  "CredentialRevocationRequested",
  "WorkspacePreparationRequested",
  "WorkspacePreparationStarted",
  "WorkspacePreparationOutput",
  "WorkspacePreparationReady",
  "WorkspacePreparationFailed",
] as const
const tags: ReadonlySet<string> = new Set(messageTags)

type Message = Extract<ExecutorMessage, { readonly _tag: (typeof messageTags)[number] }>

export const isGatewayCredentialMessage = (message: ExecutorMessage): message is Message => tags.has(message._tag)

export interface GatewayCredentialMessageDependencies {
  readonly controller: Controller
  readonly preparation: PreparationStore
  readonly branchPushCalls: Ref.Ref<Map<string, BranchPushCall>>
  readonly send: (socket: Socket, message: Parameters<typeof gatewayProtocol.encode>[0]) => void
}

export const gatewayCredentialMessageHandler = (dependencies: GatewayCredentialMessageDependencies) => {
  const request = gatewayCredentialRequestHandler(dependencies)
  const revocation = gatewayCredentialRevocationHandler(dependencies)
  const preparation = gatewayCredentialPreparationHandler(dependencies)

  return Effect.fn("ExecutorGateway.handleCredentialMessage")(function* (socket: Socket, message: Message) {
    switch (message._tag) {
      case "CredentialRequested":
        return yield* request(socket, message)
      case "CredentialRevocationRequested":
        return yield* revocation(socket, message)
      case "WorkspacePreparationRequested":
      case "WorkspacePreparationStarted":
      case "WorkspacePreparationOutput":
      case "WorkspacePreparationReady":
      case "WorkspacePreparationFailed":
        return yield* preparation(socket, message)
    }
  })
}
