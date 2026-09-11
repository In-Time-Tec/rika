import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Data, Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { spawnOwned } from "./owned-child-process"

class DevelopmentApiError extends Data.TaggedError("DevelopmentApiError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

const apiCommand = ChildProcess.make("bun", ["--cwd", "apps/api", "start"], {
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
})

const program = Effect.gen(function* () {
  const api = yield* spawnOwned(apiCommand)
  const exitCode = Number(yield* api.exitCode)
  if (exitCode !== 0) return yield* new DevelopmentApiError({ message: `API exited with code ${exitCode}` })
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
