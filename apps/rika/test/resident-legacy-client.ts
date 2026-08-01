import { Effect } from "effect"
import { FixtureFailure } from "./resident-transport-runtime"

export const legacyClose = (url: string) =>
  Effect.callback<{ readonly code: number; readonly reason: string }, FixtureFailure>((resume) => {
    const socket = new WebSocket(url)
    socket.addEventListener("close", (event) => resume(Effect.succeed({ code: event.code, reason: event.reason })))
    socket.addEventListener("error", (cause) =>
      resume(Effect.fail(new FixtureFailure({ operation: "connect legacy resident client", cause }))),
    )
    return Effect.sync(() => socket.close())
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.fail(new FixtureFailure({ operation: "wait for legacy close", cause: "timed out" })),
    }),
  )
