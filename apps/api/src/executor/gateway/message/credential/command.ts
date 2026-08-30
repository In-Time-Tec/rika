import type { CredentialCommand } from "@rika/e2b-executor/controller"
import type { ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect, Ref } from "effect"
import type { Socket } from "../../contract"
import type { GatewayCredentialMessageDependencies } from "./core"
import { gatewayProtocol } from "../../protocol"

export type CredentialMessage = Extract<
  ExecutorMessage,
  { readonly _tag: "CredentialRequested" | "CredentialRevocationRequested" }
>

export const credentialCommand = (message: CredentialMessage) =>
  (message.purpose === "branch-push"
    ? {
        ownerId: message.ownerId,
        assignmentId: message.assignmentId,
        repositoryId: message.repositoryId,
        workspaceId: message.workspaceId,
        assignmentGeneration: message.assignmentGeneration,
        leaseEpoch: message.leaseEpoch,
        purpose: "branch-push",
        publicationId: message.publicationId!,
        branch: message.branch!,
        ref: message.ref!,
        commitSha: message.commitSha!,
      }
    : {
        ownerId: message.ownerId,
        assignmentId: message.assignmentId,
        repositoryId: message.repositoryId,
        workspaceId: message.workspaceId,
        assignmentGeneration: message.assignmentGeneration,
        leaseEpoch: message.leaseEpoch,
        purpose: message.purpose,
      }) satisfies CredentialCommand

export const validCredentialPurpose = (message: CredentialMessage) =>
  message.purpose === "branch-push"
    ? message.publicationId !== undefined &&
      (message._tag !== "CredentialRequested" || message.publicationId === message.requestId) &&
      message.branch !== undefined &&
      message.ref !== undefined &&
      message.commitSha !== undefined
    : message.publicationId === undefined &&
      message.branch === undefined &&
      message.ref === undefined &&
      message.commitSha === undefined

export const validBranchPushCredential = (dependencies: GatewayCredentialMessageDependencies) =>
  Effect.fn("ExecutorGateway.validBranchPushCredential")(function* (socket: Socket, message: CredentialMessage) {
    if (message.purpose !== "branch-push") return true
    const call = (yield* Ref.get(dependencies.branchPushCalls)).get(message.publicationId!)
    return (
      call !== undefined &&
      call.socket === socket &&
      gatewayProtocol.sameAccess(call.access, message.access) &&
      call.assignmentId === message.assignmentId &&
      call.ownerId === message.ownerId &&
      call.repositoryId === message.repositoryId &&
      call.workspaceId === message.workspaceId &&
      call.branch === message.branch &&
      call.ref === message.ref &&
      call.commitSha === message.commitSha
    )
  })
