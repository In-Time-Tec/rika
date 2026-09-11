import { Effect } from "effect"

export const loadConnectedTui = Effect.tryPromise({
  try: () => import("@rika/tui-v2/src/launch"),
  catch: () => ({ message: "Connected TUI support could not be loaded" }),
})
