import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Database } from "bun:sqlite"
import { Data, Effect, FileSystem, Layer, Path, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class PackageSmokeError extends Data.TaggedError("PackageSmokeError")<{ readonly message: string }> {}

const MigrationCount = Schema.Struct({ count: Schema.Finite })
const failure = (message: string) => new PackageSmokeError({ message })

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const platform = `${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`
  const root = path.resolve(import.meta.dir, "..")
  const temporary = yield* fileSystem.makeTempDirectoryScoped({ prefix: "rika-artifact-" })
  const home = path.join(temporary, "home")
  const state = path.join(temporary, "state")
  yield* fileSystem.makeDirectory(home)
  const archive = path.join(root, "artifacts", `rika-${platform}.tar.gz`)
  const run = Effect.fn("PackageSmoke.run")(
    (command: string, args: ReadonlyArray<string>, env?: Record<string, string>) =>
      spawner.exitCode(ChildProcess.make(command, args, { cwd: temporary, env })),
  )
  const extracted = yield* run("tar", ["-xzf", archive, "-C", temporary])
  if (Number(extracted) !== 0) return yield* failure(`Failed to extract artifact: tar exited with code ${extracted}`)
  const binary = path.join(temporary, `rika-${platform}`, "bin", "rika")
  const env = {
    HOME: home,
    RIKA_DATABASE: path.join(state, "rika.db"),
    RIKA_RELAY_DATABASE: path.join(state, "relay.db"),
  }
  for (const args of [["--help"], ["--version"], ["tools", "list"], ["threads", "new"], ["threads", "list"]]) {
    const exitCode = yield* run(binary, args, env)
    if (Number(exitCode) !== 0)
      return yield* failure(`Artifact command failed: ${args.join(" ")}\nexited with code ${exitCode}`)
  }
  const files = yield* fileSystem.readDirectory(state)
  if (!files.includes("rika.db")) return yield* failure("Product migration database was not created")
  const row = yield* Effect.acquireRelease(
    Effect.sync(() => new Database(path.join(state, "rika.db"), { readonly: true })),
    (database) => Effect.sync(() => database.close()),
  ).pipe(Effect.map((database) => database.query("select count(*) as count from rika_migrations").get()))
  const migrations = yield* Schema.decodeUnknownEffect(MigrationCount)(row).pipe(
    Effect.mapError((error) => failure(`Invalid migration query result: ${error.message}`)),
  )
  if (migrations.count < 1) return yield* failure("Product migrations were not applied and retained across reopen")
  const tree = yield* spawner.string(
    ChildProcess.make("find", [path.join(temporary, `rika-${platform}`), "-type", "l", "-print"]),
  )
  if (tree.trim() !== "") return yield* failure(`Artifact contains links: ${tree}`)
  const inventory = yield* spawner
    .string(ChildProcess.make("tar", ["-tzf", archive]))
    .pipe(Effect.map((value) => value.toLowerCase()))
  for (const excluded of ["rivet", "postgres", "docker.sock", "baton/node_modules", "relay/node_modules"])
    if (inventory.includes(excluded)) return yield* failure(`Artifact contains excluded dependency: ${excluded}`)
  const child = yield* spawner.spawn(
    ChildProcess.make(binary, [], {
      cwd: temporary,
      env: { ...env, TERM: "xterm-256color" },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    }),
  )
  yield* Effect.sleep("500 millis")
  yield* child.kill({ signal: "SIGTERM" })
  yield* Effect.exit(child.exitCode).pipe(
    Effect.timeout("5 seconds"),
    Effect.mapError(() => failure("Artifact did not tear down after SIGTERM")),
  )
})

BunRuntime.runMain(
  Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
)
