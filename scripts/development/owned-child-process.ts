import { Effect } from "effect"
import { type ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

export const spawnOwned = Effect.fn("DevelopmentProcess.spawnOwned")(function* (command: ChildProcess.Command) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  return yield* Effect.acquireRelease(spawner.spawn(command), (process) =>
    process.kill({ forceKillAfter: "5 seconds" }).pipe(Effect.ignore),
  )
})
