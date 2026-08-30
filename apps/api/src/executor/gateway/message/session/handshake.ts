import { redactAccess, redactHello, type ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect, Redacted } from "effect"
import type { Socket } from "../../contract"
import type { GatewaySessionMessageDependencies } from "./core"

type Message = Extract<ExecutorMessage, { readonly _tag: "ExecutorHello" | "ExecutorReconnect" }>

export const gatewaySessionHandshakeHandler = (dependencies: GatewaySessionMessageDependencies) =>
  Effect.fn("ExecutorGateway.handleSessionHandshake")(function* (socket: Socket, message: Message) {
    if (message._tag === "ExecutorHello") {
      const welcome = yield* dependencies.controller.hello(redactHello(message.hello))
      const sessionToken = Redacted.value(welcome.sessionToken)
      const session = {
        socket,
        access: { version: 1 as const, fence: welcome.fence, leaseEpoch: welcome.leaseEpoch, sessionToken },
        leaseExpiresAt: welcome.leaseExpiresAt,
        ready: false,
        environmentDigest: null,
      }
      if (yield* dependencies.register(session)) {
        dependencies.send(socket, { _tag: "ExecutorWelcome", welcome: { ...welcome, sessionToken } })
        yield* dependencies.grant(
          session,
          message.lifecycle === "fresh" ? "setup" : "runtime",
          null,
          message.environmentDigest,
        )
      }
      return true
    }
    const welcome = yield* dependencies.controller.reconnect(redactAccess(message.access))
    const session = {
      socket,
      access: { ...message.access, leaseEpoch: welcome.leaseEpoch },
      leaseExpiresAt: welcome.leaseExpiresAt,
      ready: false,
      environmentDigest: null,
    }
    if (yield* dependencies.register(session)) {
      dependencies.send(socket, { _tag: "ExecutorReconnected", welcome })
      yield* dependencies.grant(session, "runtime", null)
    }
    return true
  })
