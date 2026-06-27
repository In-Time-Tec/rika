import { NodeServices } from "@effect/platform-node"
import { Config } from "@rika/core"
import { Ids } from "@rika/schema"
import { Console, Effect, Option, Ref, Schema } from "effect"
import { Argument, CliError, Command as CliCommand, Flag } from "effect/unstable/cli"

export interface ExecuteCommand extends Schema.Schema.Type<typeof ExecuteCommand> {}
export const ExecuteCommand = Schema.Struct({
  type: Schema.Literal("execute"),
  prompt: Schema.String,
  mode: Schema.optional(Config.Mode),
  workspace_root: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
  ephemeral: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Args.ExecuteCommand" })

export interface InteractiveCommand extends Schema.Schema.Type<typeof InteractiveCommand> {}
export const InteractiveCommand = Schema.Struct({
  type: Schema.Literal("interactive"),
  mode: Schema.optional(Config.Mode),
  workspace_root: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
  ephemeral: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Args.InteractiveCommand" })

export type Command = ExecuteCommand | InteractiveCommand

export class ArgsError extends Schema.TaggedErrorClass<ArgsError>()("ArgsError", {
  message: Schema.String,
  exit_code: Schema.Int,
  usage: Schema.optional(Schema.String),
}) {}

export const usage = [
  "Usage:",
  "  rika [options]",
  "  rika interactive [options]",
  "  rika run [options] <prompt>",
  "  rika --execute [options] <prompt>",
  "",
  "Options:",
  "  -e, --execute           Run one non-interactive turn",
  "  --mode <rush|smart|deep> Select agent mode",
  "  --workspace <path>      Workspace root for the turn",
  "  --thread <id>           Reuse a durable thread id",
  "  --ephemeral            Use in-memory persistence for this run",
  "  -h, --help             Show this help",
].join("\n")

export const parse = Effect.fn("Cli.Args.parse")(function* (argv: ReadonlyArray<string>) {
  const parsedRef = yield* Ref.make(Option.none<Command>())
  const rejectedRef = yield* Ref.make(Option.none<ArgsError>())
  const captured = makeCapturedConsole()
  const command = makeCommand(parsedRef, rejectedRef)
  const result = yield* Effect.result(
    CliCommand.runWith(command, { version: "0.0.0" })(argv).pipe(
      Effect.provideService(Console.Console, captured.console),
      Effect.provide(NodeServices.layer),
    ),
  )

  const rejected = yield* Ref.get(rejectedRef)
  if (Option.isSome(rejected)) return yield* rejected.value

  const parsed = yield* Ref.get(parsedRef)
  if (Option.isSome(parsed)) return parsed.value

  if (result._tag === "Failure") return yield* cliErrorToArgsError(result.failure, captured)

  const rendered = renderCapturedConsole(captured)
  if (rendered.length > 0) return yield* new ArgsError({ message: rendered, exit_code: 0 })

  return yield* usageError()
})

const baseConfig = {
  mode: Flag.choice("mode", ["rush", "smart", "deep"]).pipe(Flag.optional, Flag.withDescription("Select agent mode")),
  workspace: Flag.string("workspace").pipe(Flag.optional, Flag.withDescription("Workspace root for the turn")),
  thread: Flag.string("thread").pipe(Flag.optional, Flag.withDescription("Reuse a durable thread id")),
  ephemeral: Flag.boolean("ephemeral").pipe(Flag.withDescription("Use in-memory persistence for this run")),
}

const executeConfig = {
  ...baseConfig,
  prompt: Argument.string("prompt").pipe(
    Argument.variadic({ min: 1 }),
    Argument.withDescription("Prompt text to send to the agent"),
  ),
}

const rootConfig = {
  execute: Flag.boolean("execute").pipe(Flag.withAlias("e"), Flag.withDescription("Run one non-interactive turn")),
  ...baseConfig,
  prompt: Argument.string("prompt").pipe(
    Argument.variadic({ min: 0 }),
    Argument.withDescription("Prompt text to send to the agent when --execute is set"),
  ),
}

interface ExecuteInput {
  readonly mode: Option.Option<Config.Mode>
  readonly workspace: Option.Option<string>
  readonly thread: Option.Option<string>
  readonly ephemeral: boolean
  readonly prompt: ReadonlyArray<string>
}

interface InteractiveInput {
  readonly mode: Option.Option<Config.Mode>
  readonly workspace: Option.Option<string>
  readonly thread: Option.Option<string>
  readonly ephemeral: boolean
}

interface RootInput extends ExecuteInput {
  readonly execute: boolean
}

const makeCommand = (parsedRef: Ref.Ref<Option.Option<Command>>, rejectedRef: Ref.Ref<Option.Option<ArgsError>>) => {
  const run = CliCommand.make("run", executeConfig, (input: ExecuteInput) =>
    Ref.set(parsedRef, Option.some(toExecuteCommand(input))),
  ).pipe(
    CliCommand.withDescription("Run one non-interactive Rika turn"),
    CliCommand.withShortDescription("Run one prompt"),
  )

  const interactive = CliCommand.make("interactive", baseConfig, (input: InteractiveInput) =>
    Ref.set(parsedRef, Option.some(toInteractiveCommand(input))),
  ).pipe(
    CliCommand.withDescription("Start Rika's interactive terminal UI"),
    CliCommand.withShortDescription("Start interactive UI"),
  )

  return CliCommand.make("rika", rootConfig, (input: RootInput) =>
    input.execute
      ? input.prompt.length === 0
        ? Ref.set(
            rejectedRef,
            Option.some(new ArgsError({ message: "Prompt is required for --execute", exit_code: 2, usage })),
          )
        : Ref.set(parsedRef, Option.some(toExecuteCommand(input)))
      : input.prompt.length === 0
        ? Ref.set(parsedRef, Option.some(toInteractiveCommand(input)))
        : Ref.set(
            rejectedRef,
            Option.some(new ArgsError({ message: "Expected run, interactive, or --execute", exit_code: 2, usage })),
          ),
  ).pipe(CliCommand.withDescription("Effect-native coding agent"), CliCommand.withSubcommands([run, interactive]))
}

const toExecuteCommand = (input: ExecuteInput): ExecuteCommand => {
  const mode = Option.getOrUndefined(input.mode)
  const workspaceRoot = Option.getOrUndefined(input.workspace)
  const threadId = Option.getOrUndefined(input.thread)
  return {
    type: "execute",
    prompt: input.prompt.join(" ").trim(),
    ephemeral: input.ephemeral,
    ...(mode === undefined ? {} : { mode }),
    ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot }),
    ...(threadId === undefined ? {} : { thread_id: Ids.ThreadId.make(threadId) }),
  }
}

const toInteractiveCommand = (input: InteractiveInput): InteractiveCommand => {
  const mode = Option.getOrUndefined(input.mode)
  const workspaceRoot = Option.getOrUndefined(input.workspace)
  const threadId = Option.getOrUndefined(input.thread)
  return {
    type: "interactive",
    ephemeral: input.ephemeral,
    ...(mode === undefined ? {} : { mode }),
    ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot }),
    ...(threadId === undefined ? {} : { thread_id: Ids.ThreadId.make(threadId) }),
  }
}

interface CapturedConsole {
  readonly stdout: Array<string>
  readonly stderr: Array<string>
  readonly console: Console.Console
}

const makeCapturedConsole = (): CapturedConsole => {
  const stdout: Array<string> = []
  const stderr: Array<string> = []
  const write =
    (target: Array<string>) =>
    (...args: ReadonlyArray<unknown>) => {
      target.push(args.map(formatConsoleArg).join(" "))
    }
  return {
    stdout,
    stderr,
    console: {
      assert: noop,
      clear: noop,
      count: noop,
      countReset: noop,
      debug: write(stdout),
      dir: write(stdout),
      dirxml: write(stdout),
      error: write(stderr),
      group: write(stdout),
      groupCollapsed: write(stdout),
      groupEnd: noop,
      info: write(stdout),
      log: write(stdout),
      table: write(stdout),
      time: noop,
      timeEnd: noop,
      timeLog: write(stdout),
      trace: write(stderr),
      warn: write(stderr),
    },
  }
}

const noop = () => {}

const formatConsoleArg = (arg: unknown) => (typeof arg === "string" ? arg : JSON.stringify(arg))

const renderCapturedConsole = (captured: CapturedConsole) =>
  [...captured.stdout, ...captured.stderr].filter((line) => line.length > 0).join("\n")

const cliErrorToArgsError = (error: CliError.CliError, captured: CapturedConsole) => {
  const rendered = renderCapturedConsole(captured)
  const message = rendered.length > 0 ? rendered : error.message
  if (error instanceof CliError.ShowHelp) {
    return new ArgsError({ message, exit_code: error.errors.length === 0 ? 0 : 2 })
  }
  return new ArgsError({ message, exit_code: 2 })
}

const usageError = (message = "Expected run or --execute") => new ArgsError({ message, exit_code: 2, usage })
