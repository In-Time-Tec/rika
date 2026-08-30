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
    const outcomes = new Map(message.operations.map((operation) => [operation.operationKey, operation.outcome]))
    if ([...waiting.expected].some((operationKey) => !outcomes.has(operationKey)))
      return yield* GatewayError.make({ kind: "fenced", message: "Quiesce omitted an active operation" })
    yield* Deferred.succeed(waiting.result, {
      access: redactAccess(message.access),
      operations: message.operations,
      checkpoint: message.checkpoint,
    })
    return true
  })
