import * as BunServices from "@effect/platform-bun/BunServices"
import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { Effect, Exit, FileSystem, Layer, Scope } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as ServerEndpoint from "../src/server/process/server-endpoint"
import { serverProcessRole } from "../src/private-runtime-role"
import { reapServers } from "./client-process-test-runtime"

const app = fileURLToPath(new URL("..", import.meta.url))

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | HttpClient.HttpClient | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Layer.build(Layer.merge(BunServices.layer, FetchHttpClient.layer)).pipe(
        Effect.flatMap((context) => Effect.provide(effect, context)),
      ),
    ),
  )

const listens = (port: number) =>
  HttpClient.get(`http://127.0.0.1:${port}/`).pipe(Effect.exit, Effect.map(Exit.isSuccess))

const waitForListener = Effect.fn("PrivateRuntimeRole.waitForListener")(function* (port: number) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (yield* listens(port)) return
    yield* Effect.sleep("100 millis")
  }
  return yield* Effect.die(`The private server role did not listen on ${port}`)
})

test(
  "the public client entrypoint starts local authority through its exact private server role",
  () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "rika-private-server-" })
        const dataRoot = `${temporary}/state`
        const home = `${temporary}/home`
        yield* Effect.all([fs.makeDirectory(dataRoot), fs.makeDirectory(home)])
        const endpoint = yield* ServerEndpoint.resolve("default", dataRoot)
        yield* Effect.addFinalizer(() => reapServers(dataRoot))
        const child = yield* spawner.spawn(
          ChildProcess.make("bun", ["src/client-main.ts", serverProcessRole], {
            cwd: app,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
            extendEnv: true,
            env: {
              HOME: home,
              RIKA_DATABASE: `${dataRoot}/rika.db`,
              RIKA_INTERNAL_SERVER_DATA_ROOT: dataRoot,
              RIKA_INTERNAL_SERVER_PROFILE: "default",
              RIKA_INTERNAL_SERVER_GRACE: "60000",
              RIKA_INTERNAL_SERVER_STARTUP_HOLD: "0",
            },
          }),
        )
        yield* Effect.addFinalizer(() => child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore))
        yield* waitForListener(endpoint.port)
        expect(Number(child.pid)).toBeGreaterThan(0)
      }),
    ),
  20_000,
)
