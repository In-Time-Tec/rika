import { Config, Console, Effect, Path } from "effect"
import { Argument, Command } from "effect/unstable/cli"
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
  Effect.tryPromise(() => import("../../platform/application-performance")).pipe(
    Effect.flatMap(({ performanceEvaluation }) => performanceEvaluation),
    Effect.flatMap((report) => Console.log(JSON.stringify(report))),
  ),
).pipe(Command.withDescription("Evaluate the standard large-Thread rendering workload"))

export const diagnosticsCommand = Command.make("diagnostics").pipe(
  Command.withDescription("Inspect and export local Rika logs"),
  Command.withSubcommands([pathCommand, statusCommand, exportCommand, performanceCommand]),
)
