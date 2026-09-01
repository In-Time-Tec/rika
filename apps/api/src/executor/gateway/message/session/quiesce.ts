import { redactAccess, type ExecutorMessage } from "@rika/remote-execution/protocol"
import { Deferred, Effect, Ref } from "effect"
import { GatewayError, type Socket } from "../../contract"
import type { GatewaySessionMessageDependencies } from "./core"
import { gatewayProtocol } from "../../protocol"

type Message = Extract<ExecutorMessage, { readonly _tag: "ExecutorQuiesced" }>

export const gatewaySessionQuiesceHandler = (dependencies: GatewaySessionMessageDependencies) =>
  Effect.fn("ExecutorGateway.handleSessionQuiesce")(function* (_socket: Socket, message: Message) {
    const waiting = (yield* Ref.get(dependencies.quiescence)).get(message.access.fence.assignmentId)
    if (
      waiting === undefined ||
      waiting.requestId !== message.requestId ||
      !gatewayProtocol.sameAccess(waiting.access, message.access)
    )
      return yield* GatewayError.make({ kind: "fenced", message: "Quiesce response is stale" })
    yield* Deferred.succeed(waiting.result, {
      access: redactAccess(message.access),
      checkpoint: message.checkpoint,
    })
    return true
  })
