import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, Function, Layer, Scope } from "effect"
import * as ServerEndpoint from "../src/server/process/server-endpoint"
import { alive } from "./server-transport-process"
import { awaitExit } from "./server-process-exit"

export const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Layer.build(BunServices.layer).pipe(Effect.flatMap((context) => Effect.provide(effect, context)))),
  )

export const waitUntil: {
  <E, R>(condition: Effect.Effect<boolean, E, R>, timeout?: number): Effect.Effect<undefined, E, R>
  (timeout?: number): <E, R>(condition: Effect.Effect<boolean, E, R>) => Effect.Effect<undefined, E, R>
} = Function.dual(
  (args) => Effect.isEffect(args[0]),
  <E, R>(condition: Effect.Effect<boolean, E, R>, timeout = 10_000): Effect.Effect<undefined, E, R> =>
    Effect.gen(function* () {
      const started = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
      while (!(yield* condition)) {
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        if (now - started >= timeout) return yield* Effect.die("condition timed out")
        yield* Effect.sleep("20 millis")
      }
    }),
)

export const reapServers = (dataRoot: string) =>
  Effect.gen(function* () {
    const endpoint = yield* ServerEndpoint.resolve("default", dataRoot)
    const recorded = yield* ServerEndpoint.recordedServerProcesses(endpoint)
    const pids = recorded.map((entry) => entry.pid).filter(alive)
    yield* Effect.forEach(pids, (pid) => Effect.ignore(Effect.sync(() => process.kill(pid, "SIGKILL"))), {
      discard: true,
    })
    yield* awaitExit(pids)
  }).pipe(Effect.ignore)
