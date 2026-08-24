import { Config, Console, Effect, Option, Path } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as Logging from "../../diagnostics/file-logging"

const dataRoot = Effect.fn("DiagnosticsCommand.dataRoot")(function* () {
  const path = yield* Path.Path
  const home = yield* Config.string("HOME").pipe(Config.withDefault("."))
  return path.join(home, ".config", "rika")
})

const pathCommand = Command.make("path", {}, () =>
  dataRoot().pipe(Effect.flatMap(Logging.directory), Effect.flatMap(Console.log)),
)

const statusCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const value = yield* dataRoot().pipe(Effect.flatMap(Logging.status))
    yield* Console.log(value.directory)
    yield* Console.log(`${value.files} log file${value.files === 1 ? "" : "s"}, ${value.bytes} bytes`)
  }),
)

const exportCommand = Command.make("export", { destination: Argument.string("directory") }, ({ destination }) =>
  dataRoot().pipe(
    Effect.flatMap((root) => Logging.exportLogs(root, destination)),
    Effect.flatMap((output) => Console.log(`Exported Rika logs to ${output}`)),
  ),
)

const performanceCommand = Command.make("performance", {}, () =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const testExecutable = yield* Config.option(Config.string("RIKA_TEST_RUNTIME_EXECUTABLE"))
    let runtime
    if (Option.isSome(testExecutable)) runtime = { executable: testExecutable.value, arguments: [] }
    else if (import.meta.path.startsWith("/$bunfs/"))
      runtime = { executable: path.join(path.dirname(process.execPath), ".rika-performance"), arguments: [] }
    else
      runtime = {
        executable: process.execPath,
        arguments: [path.join(import.meta.dir, "..", "..", "performance-main.ts")],
      }
    const output = yield* spawner.string(
      ChildProcess.make(runtime.executable, runtime.arguments, {
        stdin: "ignore",
        stderr: "inherit",
        extendEnv: true,
      }),
    )
    yield* Console.log(output.trim())
  }),
).pipe(Command.withDescription("Evaluate the standard large-Thread rendering workload"))

export const diagnosticsCommand = Command.make("diagnostics").pipe(
  Command.withDescription("Inspect and export local Rika logs"),
  Command.withSubcommands([pathCommand, statusCommand, exportCommand, performanceCommand]),
)
