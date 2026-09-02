import { expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Socket } from "../../../src/executor/gateway"
import { sendFrame } from "../../../src/executor/gateway/send-frame"

const socket = (send: Socket["send"]): Socket => ({ send, close: () => undefined })

it.effect("treats written bytes, backpressure, and void sockets as delivered", () =>
  Effect.gen(function* () {
    const sent: Array<string> = []
    yield* sendFrame(
      socket((frame) => sent.push(frame) && frame.length),
      "a",
      "native operation",
    )
    yield* sendFrame(
      socket(() => -1),
      "b",
      "native operation",
    )
    yield* sendFrame(
      socket(() => undefined),
      "c",
      "native operation",
    )
    expect(sent).toEqual(["a"])
  }),
)

it.effect("fails with a transport error when the socket drops the frame", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      sendFrame(
        socket(() => 0),
        "frame",
        "Runner native operation",
      ),
    )
    expect(error.kind).toBe("transport")
    expect(error.message).toBe("Could not deliver Runner native operation: the socket dropped the frame")
  }),
)

it.effect("fails with a transport error when the socket throws", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      sendFrame(
        socket(() => {
          throw new Error("closed")
        }),
        "frame",
        "native operation",
      ),
    )
    expect(error.kind).toBe("transport")
    expect(error.message).toBe("Could not deliver native operation: Error: closed")
  }),
)
