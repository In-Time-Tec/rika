import type { Interface as Controller, Quiescence } from "@rika/e2b-executor/controller"
import type { AccessWire, ExecutorMessage } from "@rika/remote-execution/protocol"
import { Deferred, Effect, Ref } from "effect"
import type { GatewayError, Socket } from "../../contract"
import type { GatewaySession } from "../../rpc/model"
import { gatewaySessionCacheHandler } from "./cache"
import { gatewaySessionHandshakeHandler } from "./handshake"
import { gatewaySessionHeartbeatHandler } from "./heartbeat"
import { gatewaySessionQuiesceHandler } from "./quiesce"
import { gatewaySessionWorkspaceHandler } from "./workspace"
import { gatewayProtocol } from "../../protocol"

const messageTags = [
  "ExecutorHello",
  "ExecutorReconnect",
  "ExecutorHeartbeat",
  "ExecutorConnectionFailed",
  "ExecutorWorkspaceReady",
  "ExecutorQuiesced",
  "SetupCacheLookup",
  "SetupCacheProposed",
] as const
const tags: ReadonlySet<string> = new Set(messageTags)

type Message = Extract<ExecutorMessage, { readonly _tag: (typeof messageTags)[number] }>

export const isGatewaySessionMessage = (message: ExecutorMessage): message is Message => tags.has(message._tag)

export interface GatewaySessionMessageDependencies {
  readonly controller: Controller
  readonly sessions: Ref.Ref<Map<string, GatewaySession>>
  readonly quiescing: Ref.Ref<Set<string>>
  readonly quiescence: Ref.Ref<
    Map<
      string,
      {
        readonly access: AccessWire
        readonly requestId: string
        readonly result: Deferred.Deferred<Quiescence, GatewayError>
      }
    >
  >
  readonly register: (session: GatewaySession) => Effect.Effect<boolean, GatewayError>
  readonly grant: (
    session: GatewaySession,
    phase: "setup" | "runtime",
    operationKey: null,
    expectedEnvironmentDigest?: string,
  ) => Effect.Effect<void, GatewayError>
  readonly replayPending: (session: GatewaySession) => Effect.Effect<void, GatewayError>
  readonly send: (socket: Socket, message: Parameters<typeof gatewayProtocol.encode>[0]) => void
}

export const gatewaySessionMessageHandler = (dependencies: GatewaySessionMessageDependencies) => {
  const handshake = gatewaySessionHandshakeHandler(dependencies)
  const heartbeat = gatewaySessionHeartbeatHandler(dependencies)
  const workspace = gatewaySessionWorkspaceHandler(dependencies)
  const quiesce = gatewaySessionQuiesceHandler(dependencies)
  const cache = gatewaySessionCacheHandler(dependencies)

  return Effect.fn("ExecutorGateway.handleSessionMessage")(function* (socket: Socket, message: Message) {
    switch (message._tag) {
      case "ExecutorHello":
      case "ExecutorReconnect":
        return yield* handshake(socket, message)
      case "ExecutorHeartbeat":
      case "ExecutorConnectionFailed":
        return yield* heartbeat(socket, message)
      case "ExecutorWorkspaceReady":
        return yield* workspace(socket, message)
      case "ExecutorQuiesced":
        return yield* quiesce(socket, message)
      case "SetupCacheLookup":
      case "SetupCacheProposed":
        return yield* cache(socket, message)
    }
  })
}
