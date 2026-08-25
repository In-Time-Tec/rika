import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Console, Data, Effect, Layer } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class CaddyError extends Data.TaggedError("CaddyError")<{ readonly message: string }> {}

const program = Effect.gen(function* () {
  const publicUrl = yield* Config.string("PUBLIC_URL")
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const caddy = yield* spawner.spawn(
    ChildProcess.make("caddy", ["run", "--config", "infra/development/Caddyfile", "--adapter", "caddyfile"], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }),
  )
  yield* Console.log(publicUrl)
  const exitCode = Number(yield* caddy.exitCode)
  if (exitCode !== 0) return yield* new CaddyError({ message: `Caddy exited with code ${exitCode}` })
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
