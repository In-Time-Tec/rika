import { redactAccess, type ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect } from "effect"
import { GatewayError, type Socket } from "../../contract"
import type { GatewayCredentialMessageDependencies } from "./core"
import { credentialCommand, validBranchPushCredential, validCredentialPurpose } from "./command"

type Message = Extract<ExecutorMessage, { readonly _tag: "CredentialRevocationRequested" }>

export const gatewayCredentialRevocationHandler = (dependencies: GatewayCredentialMessageDependencies) => {
  const validBranchPush = validBranchPushCredential(dependencies)
  return Effect.fn("ExecutorGateway.handleCredentialRevocation")(function* (socket: Socket, message: Message) {
    if (
      message.ownerId.length === 0 ||
      message.assignmentId !== message.access.fence.assignmentId ||
      message.assignmentGeneration !== message.access.fence.assignmentGeneration ||
      message.leaseEpoch !== message.access.leaseEpoch
    )
      return yield* GatewayError.make({ kind: "fenced", message: "Credential revocation scope is stale" })
    if (!validCredentialPurpose(message))
      return yield* GatewayError.make({ kind: "fenced", message: "Credential revocation purpose is invalid" })
    if (!(yield* validBranchPush(socket, message)))
      return yield* GatewayError.make({ kind: "fenced", message: "Branch push revocation scope is stale" })
    yield* dependencies.controller.revokeCredential(redactAccess(message.access), credentialCommand(message))
    return true
  })
}
