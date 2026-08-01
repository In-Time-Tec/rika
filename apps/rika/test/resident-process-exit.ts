import { Duration, Effect } from "effect"
import { alive, hostPids } from "./resident-transport-process"

const exitPoll = Duration.millis(20)
const exitTimeout = Duration.seconds(10)

export const awaitExit = (pids: ReadonlyArray<number>) =>
  Effect.gen(function* () {
    let remaining = pids.filter(alive)
    while (remaining.length > 0) {
      yield* Effect.sleep(exitPoll)
      remaining = remaining.filter(alive)
    }
    return remaining
  }).pipe(Effect.timeoutOrElse({ duration: exitTimeout, orElse: () => Effect.sync(() => pids.filter(alive)) }))

export const killTrackedHosts = () => {
  const pids = [...hostPids]
  hostPids.clear()
  for (const pid of pids) {
    try {
      globalThis.process.kill(pid, "SIGKILL")
    } catch {}
  }
  return Effect.runPromise(awaitExit(pids))
}
