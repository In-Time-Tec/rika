import { redactAccess, redactHeartbeat, type ExecutorMessage } from "@rika/remote-execution/protocol"
import { Effect, Ref } from "effect"
import type { Socket } from "../../contract"
import type { GatewaySessionMessageDependencies } from "./core"
import { gatewayProtocol } from "../../protocol"

type Message = Extract<ExecutorMessage, { readonly _tag: "ExecutorHeartbeat" | "ExecutorConnectionFailed" }>

export const gatewaySessionHeartbeatHandler = (dependencies: GatewaySessionMessageDependencies) =>
  Effect.fn("ExecutorGateway.handleSessionHeartbeat")(function* (socket: Socket, message: Message) {
    if (message._tag === "ExecutorHeartbeat") {
      const receipt = yield* dependencies.controller.heartbeat(redactHeartbeat(message.heartbeat))
      const current = (yield* Ref.get(dependencies.sessions)).get(message.heartbeat.access.fence.assignmentId)
      const registered = yield* dependencies.register({
        socket,
        access: { ...message.heartbeat.access, leaseEpoch: receipt.leaseEpoch },
        leaseExpiresAt: receipt.leaseExpiresAt,
        ready: current?.socket === socket && current.ready,
        environmentDigest: current?.environmentDigest ?? null,
      })
      if (registered) dependencies.send(socket, { _tag: "LeaseReceipt", receipt })
      return true
    }
    yield* dependencies.controller
      .validateAccess(redactAccess(message.access))
      .pipe(Effect.mapError(gatewayProtocol.accessFailure))
    yield* Effect.logWarning("executor-host.connection-failed").pipe(
      Effect.annotateLogs({
        "rika.assignment.id": message.access.fence.assignmentId,
        "rika.executor.id": message.access.fence.executorId,
        "rika.executor.failure.stage": message.stage,
        "rika.error.message": message.message,
      }),
    )
    return true
  })
