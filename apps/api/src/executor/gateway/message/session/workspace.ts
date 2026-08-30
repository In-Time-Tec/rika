import { redactAccess, type ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect, Ref } from "effect"
import { GatewayError, type Socket } from "../../contract"
import type { GatewaySessionMessageDependencies } from "./core"
import { gatewayProtocol } from "../../protocol"

type Message = Extract<ExecutorMessage, { readonly _tag: "ExecutorWorkspaceReady" }>

export const gatewaySessionWorkspaceHandler = (dependencies: GatewaySessionMessageDependencies) =>
  Effect.fn("ExecutorGateway.handleSessionWorkspace")(function* (socket: Socket, message: Message) {
    const { sameAccess } = gatewayProtocol
    const workspaceSession = (yield* Ref.get(dependencies.sessions)).get(message.access.fence.assignmentId)
    if (
      workspaceSession === undefined ||
      workspaceSession.socket !== socket ||
      !sameAccess(workspaceSession.access, message.access) ||
      workspaceSession.environmentDigest === null
    )
      return yield* GatewayError.make({ kind: "fenced", message: "Workspace proof is stale" })
    yield* dependencies.controller.ready(
      redactAccess(message.access),
      message.proof,
      message.capabilities,
      workspaceSession.environmentDigest,
    )
    const session = yield* Ref.modify(dependencies.sessions, (active) => {
      const current = active.get(message.access.fence.assignmentId)
      if (current === undefined || current.socket !== socket || !sameAccess(current.access, message.access))
        return [undefined, active] as const
      const ready = { ...current, ready: true }
      return [ready, new Map(active).set(message.access.fence.assignmentId, ready)] as const
    })
    if (session === undefined) return yield* GatewayError.make({ kind: "fenced", message: "Workspace proof is stale" })
    yield* Ref.update(dependencies.quiescing, (current) => {
      const next = new Set(current)
      next.delete(message.access.fence.assignmentId)
      return next
    })
    dependencies.send(socket, { _tag: "WorkspaceAccepted", fence: message.access.fence })
    yield* dependencies.replayPending(session)
    return true
  })
