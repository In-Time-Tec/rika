import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import { Console, Effect, Layer, Stdio } from "effect"
import { CliError, Command, Flag } from "effect/unstable/cli"
import { scenarios } from "./client/model"
import type { LaunchOptions } from "./launch"
import manifest from "../package.json"

const command = Command.make(
  "rika-tui-v2",
  {
    offline: Flag.boolean("offline").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Run a deterministic offline scenario instead of connecting to Rika"),
    ),
    scenario: Flag.choice(
      "scenario",
      scenarios.map(({ id }) => id),
    ).pipe(Flag.withDefault("welcome"), Flag.withDescription("Select the scenario used with --offline")),
    animate: Flag.boolean("animate").pipe(
      Flag.withDefault(true),
      Flag.withDescription("Animate activity indicators; use --no-animate for stable frames"),
    ),
    apiUrl: Flag.string("api-url").pipe(Flag.withDefault(""), Flag.withDescription("Rika API base URL")),
    workspace: Flag.string("workspace").pipe(
      Flag.withDefault(""),
      Flag.withDescription("Local Runner checkout; defaults to the current directory"),
    ),
    thread: Flag.string("thread").pipe(Flag.withDefault(""), Flag.withDescription("Existing Thread id to reopen")),
    box: Flag.boolean("box").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Create a new Thread in a Box instead of on the local Runner"),
    ),
  },
  Effect.fn("TuiV2.command")(function* (options) {
    const launchOptions = yield* resolveLaunchOptions(options, process.cwd())
    const stdio = yield* Stdio.Stdio
    if (!(yield* stdio.stdinIsTerminal) || !(yield* stdio.stdoutIsTerminal)) {
      return yield* CliError.UserError.make({
        cause: "Interactive terminal required",
        userMessage: "Run rika-tui-v2 in an interactive terminal. Use --help or scenarios for noninteractive output.",
      })
    }
    const { launch } = yield* Effect.tryPromise(() => import("./launch"))
    yield* Effect.scoped(launch(launchOptions))
  }),
).pipe(
  Command.withDescription("Rika TUI v2 — local Runner by default, Box by explicit selection, or offline scenarios"),
  Command.withSubcommands([
    Command.make("scenarios", {}, () =>
      Console.log(scenarios.map(({ id, title }) => `${id.padEnd(14)} ${title}`).join("\n")),
    ).pipe(Command.withDescription("List the built-in offline scenarios")),
  ]),
)

export interface MainOptions {
  readonly offline: boolean
  readonly scenario: (typeof scenarios)[number]["id"]
  readonly animate: boolean
  readonly apiUrl: string
  readonly workspace: string
  readonly thread: string
  readonly box: boolean
}

const userError = (cause: string, userMessage: string) => CliError.UserError.make({ cause, userMessage })

export const resolveLaunchOptions = Effect.fn("TuiV2.resolveLaunchOptions")(function* (
  options: MainOptions,
  cwd: string,
) {
  const base: LaunchOptions = { scenario: options.scenario, animate: options.animate }
  if (options.offline) {
    if (options.apiUrl.length > 0 || options.thread.length > 0 || options.workspace.length > 0 || options.box)
      return yield* userError(
        "Offline mode cannot use online connection options",
        "Use --offline with scenario options only, or remove --offline to connect to Rika.",
      )
    return base
  }
  if (options.apiUrl.length === 0)
    return yield* userError(
      "Online mode requires an API URL",
      "Pass --api-url to connect to Rika, or pass --offline to run a deterministic scenario.",
    )
  if (options.box && options.thread.length > 0)
    return yield* userError(
      "An existing Thread already has an execution target",
      "The existing Thread already has an execution target; use --thread by itself, or remove it to create a new Thread in a Box.",
    )
  const connection: NonNullable<LaunchOptions["connection"]> = {
    apiUrl: options.apiUrl,
    workspace: options.workspace.length === 0 ? cwd : options.workspace,
    target: options.box ? "orb" : "runner",
  }
  if (options.thread.length > 0) Object.assign(connection, { threadId: options.thread })
  return { ...base, connection }
})

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
