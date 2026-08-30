import { redactAccess, type ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect, Redacted } from "effect"
import { GatewayError, type Socket } from "../../contract"
import type { GatewayCredentialMessageDependencies } from "./core"
import { credentialCommand, validBranchPushCredential, validCredentialPurpose } from "./command"

type Message = Extract<ExecutorMessage, { readonly _tag: "CredentialRequested" }>

export const gatewayCredentialRequestHandler = (dependencies: GatewayCredentialMessageDependencies) => {
  const validBranchPush = validBranchPushCredential(dependencies)
  return Effect.fn("ExecutorGateway.handleCredentialRequest")(function* (socket: Socket, message: Message) {
    if (!validCredentialPurpose(message))
      return yield* GatewayError.make({ kind: "fenced", message: "Credential request purpose is invalid" })
    if (!(yield* validBranchPush(socket, message)))
      return yield* GatewayError.make({
        kind: "fenced",
        message: "Branch push credential was not requested by the approved operation",
      })
    const credential = yield* dependencies.controller.credential(
      redactAccess(message.access),
      credentialCommand(message),
    )
    const response = {
      requestId: message.requestId,
      ownerId: message.ownerId,
      assignmentId: message.assignmentId,
      repositoryId: message.repositoryId,
      workspaceId: message.workspaceId,
      purpose: message.purpose,
      assignmentGeneration: message.assignmentGeneration,
      leaseEpoch: message.leaseEpoch,
      ...credential,
      token: Redacted.value(credential.token),
    }
    if (message.purpose === "branch-push")
      Object.assign(response, {
        publicationId: message.publicationId,
        branch: message.branch,
        ref: message.ref,
        commitSha: message.commitSha,
      })
    dependencies.send(socket, { _tag: "RepositoryCredential", credential: response })
    return true
  })
}
