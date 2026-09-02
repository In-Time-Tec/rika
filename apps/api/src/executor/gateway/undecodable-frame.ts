import { Effect } from "effect"
import type { Socket, SocketFrame } from "./contract"

const tagPattern = /"_tag"\s*:\s*"([^"]{1,64})"/
const issueLimit = 512

/**
 * A frame the current wire schema cannot decode almost always means the peer
 * was built against another protocol generation, for example an Executor image
 * that predates a wire change. Closing silently hides that from operators, so
 * the gateway names the frame tag and the schema issue before closing.
 */
const close = (
  kind: "executor" | "runner",
  socket: Socket,
  frame: SocketFrame,
  cause: { readonly message: string },
) => {
  const text = Buffer.from(frame).toString("utf8")
  const tag = tagPattern.exec(text)?.[1] ?? "unknown"
  return Effect.logError("gateway.frame-undecodable").pipe(
    Effect.annotateLogs({
      "rika.websocket.kind": kind,
      "rika.frame.tag": tag,
      "rika.frame.bytes": text.length,
      "rika.error.message": cause.message.slice(0, issueLimit),
    }),
    Effect.andThen(Effect.sync(() => socket.close(1007, `undecodable ${tag} frame; peer protocol does not match`))),
  )
}

export const undecodableFrame = { close }
