import * as BunServices from "@effect/platform-bun/BunServices"
import { Database } from "bun:sqlite"
import { test } from "vitest"
import { fileURLToPath } from "node:url"
import { Data, Effect, FileSystem, Layer, Path } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

class PackageSmokeError extends Data.TaggedError("PackageSmokeError")<{ readonly message: string }> {}

const failure = (message: string) => new PackageSmokeError({ message })

const program = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const platform = `${process.platform}-${process.arch === "x64" ? "x64" : "arm64"}`
  const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..")
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
  const privateRuntime = path.join(temporary, `rika-${platform}`, "bin", ".rika-runtime")
  for (const executable of [binary, privateRuntime]) {
    const info = yield* fileSystem.stat(executable)
    if (info.type !== "File" || (info.mode & 0o111) === 0)
      return yield* failure(`Packaged executable is missing or not executable: ${executable}`)
  }
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
  if (!files.includes("rika.db")) return yield* failure("Product database was not created")
  const objects = yield* Effect.acquireRelease(
    Effect.sync(() => new Database(path.join(state, "rika.db"), { readonly: true })),
    (database) => Effect.sync(() => database.close()),
  ).pipe(
    Effect.map((database) =>
      database
        .query<{ type: string; name: string }, []>(
          "select type, name from sqlite_schema where type in ('table', 'index', 'trigger', 'view') and name not like 'sqlite_%' order by type, name",
        )
        .all()
        .map((row) => `${row.type}:${row.name}`),
    ),
  )
  const expectedObjects = [
    "index:rika_thread_turn_activity_summary",
    "index:rika_threads_listing",
    "index:rika_transcript_page",
    "index:rika_transcript_units_page",
    "index:rika_transcript_units_turn",
    "index:rika_turns_queue",
    "index:rika_turns_thread",
    "table:rika_migrations",
    "table:rika_thread_queue_state",
    "table:rika_thread_read_state",
    "table:rika_thread_turn_activity",
    "table:rika_threads",
    "table:rika_transcript_checkpoints",
    "table:rika_transcript_entries",
    "table:rika_transcript_units",
    "table:rika_turns",
    "table:rika_workspaces",
  ]
  if (objects.length !== expectedObjects.length || objects.some((object, index) => object !== expectedObjects[index]))
    return yield* failure(`Product database schema does not match the current object set: ${objects.join(", ")}`)
  const tree = yield* spawner.string(
    ChildProcess.make("find", [path.join(temporary, `rika-${platform}`), "-type", "l", "-print"]),
  )
  if (tree.trim() !== "") return yield* failure(`Artifact contains links: ${tree}`)
  const inventory = yield* spawner
    .string(ChildProcess.make("tar", ["-tzf", archive]))
    .pipe(Effect.map((value) => value.toLowerCase()))
  for (const excluded of ["rivet", "postgres", "docker.sock", "baton/node_modules", "relay/node_modules"])
    if (inventory.includes(excluded)) return yield* failure(`Artifact contains excluded dependency: ${excluded}`)
})

test(
  "packaged artifact has executable entrypoints, the current schema, and no excluded dependencies",
  () =>
    Effect.runPromise(
      Effect.scoped(Effect.flatMap(Layer.build(BunServices.layer), (context) => Effect.provide(program, context))),
    ),
  30_000,
)
