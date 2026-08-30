import { redactAccess, type ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect, Ref } from "effect"
import { GatewayError, type Socket } from "../../contract"
import type { GatewaySessionMessageDependencies } from "./core"
import { gatewayProtocol } from "../../protocol"

type Message = Extract<ExecutorMessage, { readonly _tag: "SetupCacheLookup" | "SetupCacheProposed" }>

export const gatewaySessionCacheHandler = (dependencies: GatewaySessionMessageDependencies) =>
  Effect.fn("ExecutorGateway.handleSessionCache")(function* (socket: Socket, message: Message) {
    const current = (yield* Ref.get(dependencies.sessions)).get(message.access.fence.assignmentId)
    if (
      current === undefined ||
      current.socket !== socket ||
      !gatewayProtocol.sameAccess(current.access, message.access) ||
      current.environmentDigest === null
    )
      return yield* GatewayError.make({
        kind: "fenced",
        message: message._tag === "SetupCacheLookup" ? "Setup cache request is stale" : "Setup cache proposal is stale",
      })
    if (message._tag === "SetupCacheLookup") {
      const archive = yield* dependencies.controller
        .loadSetupCache(redactAccess(message.access), message.key, current.environmentDigest)
        .pipe(Effect.catch((error) => (error.kind === "checkpoint" ? Effect.succeed(null) : Effect.fail(error))))
      dependencies.send(socket, { _tag: "SetupCacheResult", requestId: message.requestId, archive })
      return true
    }
    yield* dependencies.controller
      .storeSetupCache(redactAccess(message.access), message.key, message.archive, current.environmentDigest)
      .pipe(Effect.catch((error) => (error.kind === "checkpoint" ? Effect.void : Effect.fail(error))))
    dependencies.send(socket, { _tag: "SetupCacheAccepted", requestId: message.requestId })
    return true
  })
