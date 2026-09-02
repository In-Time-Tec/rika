import { redactAccess, redactHeartbeat, type AccessWire, type MachineOutcome } from "@rika/remote-execution/protocol"
import { Effect, Redacted } from "effect"
import type { GatewayError, Socket, SocketFrame } from "../executor/gateway"
import { undecodableFrame } from "../executor/gateway/undecodable-frame"
import type { RunnerExecutorAuthority } from "./executor"
import { gatewayModel, type Session } from "./gateway-model"

interface MessageDependencies {
  readonly authority: RunnerExecutorAuthority
  readonly register: (session: Session) => Effect.Effect<void, GatewayError>
  readonly replayPending: (session: Session) => Effect.Effect<void, import("../executor/gateway").GatewayError>
  readonly shutdown: (
    socket: Socket,
    access: Session["access"],
  ) => Effect.Effect<void, import("../executor/gateway").GatewayError>
  readonly calls: {
    readonly receiveMachine: (
      socket: Socket,
      access: AccessWire,
      operationKey: string,
      attempt: number,
      machineId: string,
      requestDigest: string,
      outcome: MachineOutcome,
    ) => Effect.Effect<void, GatewayError>
  }
}

export const runnerGatewayMessages = (dependencies: MessageDependencies) => {
  const { authority, register, replayPending, shutdown, calls } = dependencies
  const { decode, encode } = gatewayModel
  return (socket: Socket, frame: SocketFrame) =>
    decode(frame).pipe(
      Effect.matchEffect({
        onFailure: (cause) => undecodableFrame.close("runner", socket, frame, cause),
        onSuccess: (message) => {
          if (message._tag === "RunnerHello")
            return authority.hello(message.hello).pipe(
              Effect.tap((welcome) =>
                Effect.sync(() => {
                  socket.send(
                    encode({
                      _tag: "ExecutorWelcome",
                      welcome: { ...welcome, sessionToken: Redacted.value(welcome.sessionToken) },
                    }),
                  )
                }),
              ),
              Effect.tap((welcome) =>
                register({
                  socket,
                  access: {
                    version: 1,
                    fence: welcome.fence,
                    leaseEpoch: welcome.leaseEpoch,
                    sessionToken: Redacted.value(welcome.sessionToken),
                  },
                  leaseExpiresAt: welcome.leaseExpiresAt,
                  ready: true,
                  environmentDigest: null,
                }),
              ),
              Effect.catch((error) => Effect.sync(() => socket.close(1008, error.kind))),
            )
          if (message._tag === "ExecutorReconnect")
            return authority.reconnect(redactAccess(message.access)).pipe(
              Effect.flatMap((welcome) => {
                const session = {
                  socket,
                  access: { ...message.access, leaseEpoch: welcome.leaseEpoch },
                  leaseExpiresAt: welcome.leaseExpiresAt,
                  ready: true,
                  environmentDigest: null,
                }
                return Effect.sync(() => {
                  socket.send(encode({ _tag: "ExecutorReconnected", welcome }))
                }).pipe(Effect.andThen(register(session)), Effect.andThen(replayPending(session)))
              }),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "ExecutorHeartbeat")
            return authority.heartbeat(redactHeartbeat(message.heartbeat)).pipe(
              Effect.tap((receipt) =>
                register({
                  socket,
                  access: { ...message.heartbeat.access, leaseEpoch: receipt.leaseEpoch },
                  leaseExpiresAt: receipt.leaseExpiresAt,
                  ready: true,
                  environmentDigest: null,
                }),
              ),
              Effect.tap((receipt) =>
                Effect.sync(() => {
                  socket.send(encode({ _tag: "LeaseReceipt", receipt }))
                }),
              ),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "MachineResult")
            return authority.validateAccess(redactAccess(message.access)).pipe(
              Effect.andThen(
                calls.receiveMachine(
                  socket,
                  message.access,
                  message.operationKey,
                  message.attempt,
                  message.machineId,
                  message.requestDigest,
                  message.outcome,
                ),
              ),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "RunnerGoodbye")
            return shutdown(socket, message.access).pipe(
              Effect.tap(() => Effect.sync(() => socket.close(1000, "shutdown"))),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          return Effect.void
        },
      }),
      Effect.asVoid,
    )
}
