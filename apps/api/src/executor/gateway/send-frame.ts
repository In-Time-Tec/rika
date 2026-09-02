import { Effect, Function } from "effect"
import { GatewayError, type Socket } from "./contract"

/**
 * Sends one encoded frame and fails when the socket reports that it dropped the frame instead of writing or queueing
 * it. Backpressure (`-1`) still counts as delivered because the socket owns the queued frame.
 */
export const sendFrame: {
  (socket: Socket, frame: string, subject: string): Effect.Effect<void, GatewayError>
  (frame: string, subject: string): (socket: Socket) => Effect.Effect<void, GatewayError>
} = Function.dual(3, (socket: Socket, frame: string, subject: string) =>
  Effect.try({
    try: () => socket.send(frame),
    catch: (cause) =>
      GatewayError.make({ kind: "transport", message: `Could not deliver ${subject}: ${String(cause)}` }),
  }).pipe(
    Effect.flatMap((written) =>
      written === 0
        ? GatewayError.make({
            kind: "transport",
            message: `Could not deliver ${subject}: the socket dropped the frame`,
          })
        : Effect.void,
    ),
  ),
)
