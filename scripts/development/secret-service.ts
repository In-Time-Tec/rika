import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Data, Effect, FileSystem, Layer, Path, Schedule, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { spawnOwned } from "./owned-child-process"

class SecretServiceError extends Data.TaggedError("SecretServiceError")<{
  readonly message: string
}> {}

const program = Effect.gen(function* () {
  const home = yield* Config.string("HOME")
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(home, ".cache", "rika", "secret-service")
  const socket = path.join(directory, "bus")
  const address = `unix:path=${socket}`

  yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 })
  yield* fileSystem.remove(socket, { force: true })
  const bus = yield* spawnOwned(
    ChildProcess.make("dbus-daemon", ["--session", `--address=${address}`, "--nofork", "--nopidfile"], {
      stdout: "inherit",
      stderr: "inherit",
    }),
  )
  yield* fileSystem.exists(socket).pipe(
    Effect.filterOrFail(
      (exists) => exists,
      () => new SecretServiceError({ message: "Secret-service D-Bus socket is not ready" }),
    ),
    Effect.retry({ times: 100, schedule: Schedule.spaced("25 millis") }),
  )
  const keyring = yield* spawnOwned(
    ChildProcess.make("gnome-keyring-daemon", ["--foreground", "--unlock", "--components=secrets"], {
      env: { DBUS_SESSION_BUS_ADDRESS: address },
      extendEnv: true,
      stdin: "pipe",
      stdout: "inherit",
      stderr: "inherit",
    }),
  )
  yield* Stream.run(Stream.make(new TextEncoder().encode("\n")), keyring.stdin)
  const exited = yield* Effect.race(
    bus.exitCode.pipe(Effect.map((exitCode) => ({ process: "D-Bus", exitCode: Number(exitCode) }))),
    keyring.exitCode.pipe(Effect.map((exitCode) => ({ process: "GNOME Keyring", exitCode: Number(exitCode) }))),
  )
  return yield* new SecretServiceError({ message: `${exited.process} exited with code ${exited.exitCode}` })
})

if (import.meta.main)
  BunRuntime.runMain(
    Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
  )
