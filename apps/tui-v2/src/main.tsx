import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Effect, Layer, Stdio } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"
import { scenarios } from "./client/model"
import manifest from "../package.json"

const command = Command.make(
  "rika-tui-v2",
  {
    scenario: Flag.choice(
      "scenario",
      scenarios.map(({ id }) => id),
    ).pipe(Flag.withDefault("welcome"), Flag.withDescription("Select a deterministic offline scenario")),
    animate: Flag.boolean("animate").pipe(
      Flag.withDefault(true),
      Flag.withDescription("Animate activity indicators; use --no-animate for stable frames"),
    ),
  },
  Effect.fn("TuiV2.command")(function* (options) {
    const stdio = yield* Stdio.Stdio
    if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
      return yield* CliError.UserError.make({
        cause: "Interactive terminal required",
        userMessage: "Run rika-tui-v2 in an interactive terminal. Use --help or scenarios for noninteractive output.",
      })
    }
    const { launch } = yield* Effect.tryPromise(() => import("./launch"))
    yield* Effect.scoped(launch(options))
  }),
).pipe(
  Command.withDescription("Rika TUI v2 — standalone offline interface; no server, credentials or workspace execution"),
  Command.withSubcommands([
    Command.make("scenarios", {}, () =>
      Console.log(scenarios.map(({ id, title }) => `${id.padEnd(14)} ${title}`).join("\n")),
    ).pipe(Command.withDescription("List the built-in offline scenarios")),
  ]),
)

if (import.meta.main) {
  BunRuntime.runMain(
    Effect.scoped(
      Effect.gen(function* () {
        const services = yield* Layer.build(BunServices.layer)
        yield* Effect.provide(Command.run(command, { version: manifest.version }), services)
      }),
    ),
  )
}
