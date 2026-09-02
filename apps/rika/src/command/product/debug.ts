import { Config, Console, Effect, FileSystem, Option, Path, Schema, Terminal } from "effect"
import { Command, Flag } from "effect/unstable/cli"
import * as Logging from "../../diagnostics/file-logging"
import { version } from "../../platform/application-version"

const ProfileFacts = Schema.Struct({
  origin: Schema.String,
  owner: Schema.optionalKey(Schema.Struct({ kind: Schema.String })),
  project: Schema.optionalKey(Schema.String),
})
const decodeProfile = Schema.decodeUnknownOption(Schema.fromJsonString(ProfileFacts))

const stageSummary = (stages: ReadonlyArray<string>) => {
  if (stages.length === 0) return "(no lifecycle records)"
  const deduplicated = stages.filter((stage, index) => index === 0 || stages[index - 1] !== stage)
  return deduplicated.length > 12
    ? `${deduplicated.slice(0, 6).join(" → ")} → … → ${deduplicated.slice(-5).join(" → ")}`
    : deduplicated.join(" → ")
}

const annotationSummary = (annotations: Logging.RecentFailure["annotations"]) =>
  Object.entries(annotations)
    .filter(([key]) => !key.startsWith("rika.process.") && key !== "rika.version")
    .map(([key, value]) => `${key.replace(/^rika\./, "")}=${String(value)}`)
    .join(" ")

/**
 * Prints one pasteable report: install facts, login facts, and the recent runs with every WARN/ERROR record. A
 * user who hits a problem runs `rika debug` and sends the output; the report never contains credentials because
 * the log writer redacts them and this command reads only the redacted records.
 */
export const debugReport = Effect.fn("DebugCommand.report")(function* (options: { readonly runs: number }) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* Config.string("HOME").pipe(Config.withDefault("."))
  const dataRoot = path.join(home, ".config", "rika")
  const environment = yield* Config.all({
    term: Config.option(Config.string("TERM")),
    termProgram: Config.option(Config.string("TERM_PROGRAM")),
    colorterm: Config.option(Config.string("COLORTERM")),
    shell: Config.option(Config.string("SHELL")),
  })
  const terminal = yield* Effect.serviceOption(Terminal.Terminal)
  const size = yield* Option.match(terminal, {
    onNone: () => Effect.succeed("?"),
    onSome: (service) =>
      Effect.map(Effect.all([service.columns, service.rows]), ([columns, rows]) => `${columns}x${rows}`),
  })
  const profileText = yield* fs.readFileString(path.join(dataRoot, "hosted.json")).pipe(Effect.option)
  const profile = Option.flatMap(profileText, (text) => decodeProfile(text))
  const status = yield* Logging.status(dataRoot)
  const runs = yield* Logging.recentRuns(dataRoot, options.runs)
  const lines: Array<string> = [
    `Rika debug report`,
    ``,
    `rika ${version}`,
    `executable ${process.execPath}`,
    `runtime ${process.versions.bun === undefined ? `node ${process.version}` : `bun ${process.versions.bun}`}`,
    `platform ${process.platform} ${process.arch}`,
    `terminal TERM=${Option.getOrElse(environment.term, () => "(unset)")} TERM_PROGRAM=${Option.getOrElse(
      environment.termProgram,
      () => "(unset)",
    )} COLORTERM=${Option.getOrElse(environment.colorterm, () => "(unset)")} size=${size}`,
    `shell ${Option.getOrElse(environment.shell, () => "(unset)")}`,
    ``,
    Option.match(profile, {
      onNone: () => `login: none (hosted.json missing or unreadable)`,
      onSome: (facts) =>
        `login: origin=${facts.origin} owner=${facts.owner?.kind ?? "?"}${
          facts.project === undefined ? "" : ` project=${facts.project}`
        }`,
    }),
    `diagnostics: ${status.directory} (${status.files} files, ${status.bytes} bytes)`,
    ``,
  ]
  if (runs.length === 0) lines.push("No client runs recorded yet.")
  for (const run of runs) {
    lines.push(
      `run ${run.file}`,
      `  version ${run.version ?? "?"} started ${run.started ?? "?"} last ${run.lastRecord ?? "?"} records ${run.records}`,
      `  stages ${stageSummary(run.stages)}`,
    )
    if (run.failures.length === 0) lines.push(`  no warnings or errors`)
    for (const failure of run.failures) {
      lines.push(`  ${failure.level} ${failure.timestamp} ${failure.message} ${annotationSummary(failure.annotations)}`)
      if (failure.detail !== undefined)
        for (const detailLine of failure.detail.split("\n").slice(0, 40)) lines.push(`    ${detailLine}`)
    }
    lines.push(``)
  }
  return lines.join("\n")
})

const runs = Flag.integer("runs").pipe(Flag.withDescription("How many recent runs to include"), Flag.withDefault(3))

export const debugCommand = Command.make("debug", { runs }, (options) =>
  debugReport(options).pipe(Effect.flatMap(Console.log)),
).pipe(Command.withDescription("Print a shareable report of this install and its recent failures"))
