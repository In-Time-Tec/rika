import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Console, Crypto, Data, Effect, Layer, Schedule } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class CaddyError extends Data.TaggedError("CaddyError")<{ readonly message: string }> {}

const program = Effect.gen(function* () {
  const publicUrl = yield* Config.string("PUBLIC_URL")
  const executorPort = yield* Config.string("EXECUTOR_PORT")
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const http = yield* HttpClient.HttpClient
  const crypto = yield* Crypto.Crypto
  const readinessToken = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError(() => new CaddyError({ message: "Caddy readiness identity could not be created" })),
  )
  const caddy = yield* spawner.spawn(
    ChildProcess.make("caddy", ["run", "--config", "infra/development/Caddyfile", "--adapter", "caddyfile"], {
      env: { READINESS_TOKEN: readinessToken },
      extendEnv: true,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }),
  )
  const ready = http
    .get(`http://127.0.0.1:${executorPort}/.rika-ready`, {
      headers: { host: "executor.rika.test", "x-rika-readiness": readinessToken },
    })
    .pipe(
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) => new CaddyError({ message: `Caddy readiness returned ${response.status}` }),
      ),
      Effect.flatMap((response) => response.text),
      Effect.filterOrFail(
        (body) => body === readinessToken,
        () => new CaddyError({ message: "Caddy readiness identity did not match" }),
      ),
      Effect.asVoid,
      Effect.mapError(() => new CaddyError({ message: "Caddy is not ready" })),
      Effect.retry({ times: 160, schedule: Schedule.spaced("25 millis") }),
    )
  const exited = caddy.exitCode.pipe(
    Effect.flatMap((exitCode) =>
      Effect.fail(new CaddyError({ message: `Caddy exited before readiness with code ${Number(exitCode)}` })),
    ),
  )
  yield* Effect.raceFirst(ready, exited)
  yield* Console.log(publicUrl)
  const exitCode = Number(yield* caddy.exitCode)
  if (exitCode !== 0) return yield* new CaddyError({ message: `Caddy exited with code ${exitCode}` })
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(
      Effect.flatMap(Layer.build(Layer.merge(BunServices.layer, FetchHttpClient.layer)), (context) =>
        Effect.provide(program, context),
      ),
    ),
  )
