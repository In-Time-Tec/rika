import {
  redactAccess,
  redactHeartbeat,
  type AccessWire,
  type CellLifecycleFrame,
} from "@rika/remote-execution/protocol"
import { Effect, Redacted } from "effect"
import type { Socket, SocketFrame } from "../executor/gateway"
import type { RunnerExecutorAuthority } from "./executor"
import { gatewayModel, type FinalResult, type Session } from "./gateway-model"
import type { runnerGatewayCalls } from "./gateway-calls"

type Calls = ReturnType<typeof runnerGatewayCalls>
interface MessageDependencies {
  readonly authority: RunnerExecutorAuthority
  readonly register: (session: Session) => Effect.Effect<void>
  readonly replayPending: (session: Session) => Effect.Effect<void, import("../executor/gateway").GatewayError>
  readonly persistLifecycle: (
    socket: Socket,
    access: AccessWire,
    frame: CellLifecycleFrame,
  ) => Effect.Effect<void, import("../executor/gateway").GatewayError>
  readonly shutdown: (
    socket: Socket,
    access: AccessWire,
  ) => Effect.Effect<void, import("../executor/gateway").GatewayError>
  readonly complete: (
    socket: Socket,
    access: AccessWire,
    operationKey: string,
    attempt: number,
    response: import("@rika/remote-execution/protocol").CellResponse,
  ) => Effect.Effect<FinalResult, import("../executor/gateway").GatewayError>
  readonly calls: Pick<Calls, "receiveBinding" | "receiveMachine">
}
export const runnerGatewayMessages = (dependencies: MessageDependencies) => {
  const { authority, register, replayPending, persistLifecycle, shutdown, complete, calls } = dependencies
  const { decode, encode } = gatewayModel
  const receive = (socket: Socket, frame: SocketFrame) =>
    decode(frame).pipe(
      Effect.matchEffect({
        onFailure: () => Effect.sync(() => socket.close(1007, "malformed")),
        onSuccess: (message) => {
          if (message._tag === "RunnerHello")
            return authority.hello(message.hello).pipe(
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
                }),
              ),
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
              Effect.catch((error) => Effect.sync(() => socket.close(1008, error.kind))),
            )
          if (message._tag === "ExecutorReconnect")
            return authority.reconnect(redactAccess(message.access)).pipe(
              Effect.flatMap((welcome) => {
                const session = {
                  socket,
                  access: { ...message.access, leaseEpoch: welcome.leaseEpoch },
                  leaseExpiresAt: welcome.leaseExpiresAt,
                }
                return register(session).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      socket.send(encode({ _tag: "ExecutorReconnected", welcome }))
                    }),
                  ),
                  Effect.andThen(replayPending(session)),
                )
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
                }),
              ),
              Effect.tap((receipt) =>
                Effect.sync(() => {
                  socket.send(encode({ _tag: "LeaseReceipt", receipt }))
                }),
              ),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "CellLifecycle")
            return authority.validateAccess(redactAccess(message.access)).pipe(
              Effect.andThen(persistLifecycle(socket, message.access, message.frame)),
              Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
            )
          if (message._tag === "BindingInvoke")
            return authority.validateAccess(redactAccess(message.access)).pipe(
              Effect.andThen(
                calls.receiveBinding(
                  socket,
                  message.access,
                  message.operationKey,
                  message.attempt,
                  message.callId,
                  message.requestDigest,
                  message.request,
                ),
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
          if (message._tag !== "LocalCellResult") return Effect.void
          return authority.validateAccess(redactAccess(message.access)).pipe(
            Effect.andThen(complete(socket, message.access, message.operationKey, message.attempt, message.response)),
            Effect.tap((result) =>
              Effect.sync(() =>
                socket.send(
                  encode({
                    _tag: "LocalCellReceipt",
                    access: result.access ?? message.access,
                    operationKey: message.operationKey,
                    attempt: message.attempt,
                  }),
                ),
              ),
            ),
            Effect.catch(() => Effect.sync(() => socket.close(1008, "fenced"))),
          )
        },
      }),
      Effect.asVoid,
    )

  return receive
}
