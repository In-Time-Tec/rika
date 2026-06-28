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

export const ThreadAction = Schema.Literals([
  "list",
  "search",
  "archive",
  "unarchive",
  "share",
  "reference",
  "delete",
]).annotate({ identifier: "Rika.Cli.Args.ThreadAction" })
export type ThreadAction = typeof ThreadAction.Type

export interface ThreadCommand extends Schema.Schema.Type<typeof ThreadCommand> {}
export const ThreadCommand = Schema.Struct({
  type: Schema.Literal("threads"),
  action: ThreadAction,
  thread_id: Schema.optional(Ids.ThreadId),
  query: Schema.optional(Schema.String),
  include_archived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int),
}).annotate({ identifier: "Rika.Cli.Args.ThreadCommand" })

export type Command = ExecuteCommand | InteractiveCommand | ThreadCommand

export class ArgsError extends Schema.TaggedErrorClass<ArgsError>()("ArgsError", {
  message: Schema.String,
  exit_code: Schema.Int,
  usage: Schema.optional(Schema.String),
}) {}

export const usage = [
  "Usage:",
  "  rika [options]",
  "  rika interactive [options]",
  "  rika threads list [--include-archived] [--limit <n>]",
  "  rika threads search [--include-archived] [--limit <n>] <query>",
  "  rika threads archive <thread-id>",
  "  rika threads unarchive <thread-id>",
  "  rika threads share <thread-id>",
  "  rika threads reference <thread-id> [query]",
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

const threadListConfig = {
  includeArchived: Flag.boolean("include-archived").pipe(Flag.withDescription("Include archived threads")),
  limit: Flag.integer("limit").pipe(Flag.optional, Flag.withDescription("Maximum threads to return")),
}

const threadSearchConfig = {
  ...threadListConfig,
  query: Argument.string("query").pipe(Argument.variadic({ min: 1 }), Argument.withDescription("Search terms")),
}

const threadIdConfig = {
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id")),
}

const threadReferenceConfig = {
  ...threadIdConfig,
  query: Argument.string("query").pipe(
    Argument.variadic({ min: 0 }),
    Argument.withDescription("Optional reference query"),
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

interface ThreadListInput {
  readonly includeArchived: boolean
  readonly limit: Option.Option<number>
}

interface ThreadSearchInput extends ThreadListInput {
  readonly query: ReadonlyArray<string>
}

interface ThreadIdInput {
  readonly threadId: string
}

interface ThreadReferenceInput extends ThreadIdInput {
  readonly query: ReadonlyArray<string>
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

  const threads = makeThreadsCommand(parsedRef, rejectedRef)

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
  ).pipe(
    CliCommand.withDescription("Effect-native coding agent"),
    CliCommand.withSubcommands([run, interactive, threads]),
  )
}

const makeThreadsCommand = (
  parsedRef: Ref.Ref<Option.Option<Command>>,
  rejectedRef: Ref.Ref<Option.Option<ArgsError>>,
) => {
  const list = CliCommand.make("list", threadListConfig, (input: ThreadListInput) =>
    Ref.set(parsedRef, Option.some(toThreadListCommand(input))),
  ).pipe(CliCommand.withDescription("List local threads"), CliCommand.withShortDescription("List threads"))

  const search = CliCommand.make("search", threadSearchConfig, (input: ThreadSearchInput) =>
    Ref.set(parsedRef, Option.some(toThreadSearchCommand(input))),
  ).pipe(CliCommand.withDescription("Search local threads"), CliCommand.withShortDescription("Search threads"))

  const archive = CliCommand.make("archive", threadIdConfig, (input: ThreadIdInput) =>
    Ref.set(parsedRef, Option.some(toThreadIdCommand("archive", input))),
  ).pipe(CliCommand.withDescription("Archive a local thread"), CliCommand.withShortDescription("Archive thread"))

  const unarchive = CliCommand.make("unarchive", threadIdConfig, (input: ThreadIdInput) =>
    Ref.set(parsedRef, Option.some(toThreadIdCommand("unarchive", input))),
  ).pipe(CliCommand.withDescription("Unarchive a local thread"), CliCommand.withShortDescription("Unarchive thread"))

  const share = CliCommand.make("share", threadIdConfig, (input: ThreadIdInput) =>
    Ref.set(parsedRef, Option.some(toThreadIdCommand("share", input))),
  ).pipe(
    CliCommand.withDescription("Export a local thread as shareable JSON"),
    CliCommand.withShortDescription("Share thread"),
  )

  const reference = CliCommand.make("reference", threadReferenceConfig, (input: ThreadReferenceInput) =>
    Ref.set(parsedRef, Option.some(toThreadReferenceCommand(input))),
  ).pipe(
    CliCommand.withDescription("Render compact context for a referenced thread"),
    CliCommand.withShortDescription("Reference thread"),
  )

  const deleteThread = CliCommand.make("delete", threadIdConfig, (input: ThreadIdInput) =>
    Ref.set(parsedRef, Option.some(toThreadIdCommand("delete", input))),
  ).pipe(
    CliCommand.withDescription("Delete a local thread if the backend supports deletion"),
    CliCommand.withShortDescription("Delete thread"),
  )

  return CliCommand.make("threads", {}, () =>
    Ref.set(rejectedRef, Option.some(new ArgsError({ message: "Expected a threads subcommand", exit_code: 2, usage }))),
  ).pipe(
    CliCommand.withDescription("Manage local Rika threads"),
    CliCommand.withShortDescription("Manage threads"),
    CliCommand.withSubcommands([list, search, archive, unarchive, share, reference, deleteThread]),
  )
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

const toThreadListCommand = (input: ThreadListInput): ThreadCommand => {
  const limit = Option.getOrUndefined(input.limit)
  return {
    type: "threads",
    action: "list",
    ...(input.includeArchived ? { include_archived: true } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

const toThreadSearchCommand = (input: ThreadSearchInput): ThreadCommand => {
  const limit = Option.getOrUndefined(input.limit)
  return {
    type: "threads",
    action: "search",
    query: input.query.join(" ").trim(),
    ...(input.includeArchived ? { include_archived: true } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

const toThreadIdCommand = (
  action: Extract<ThreadAction, "archive" | "unarchive" | "share" | "delete">,
  input: ThreadIdInput,
): ThreadCommand => ({
  type: "threads",
  action,
  thread_id: Ids.ThreadId.make(input.threadId),
})

const toThreadReferenceCommand = (input: ThreadReferenceInput): ThreadCommand => {
  const query = input.query.join(" ").trim()
  return {
    type: "threads",
    action: "reference",
    thread_id: Ids.ThreadId.make(input.threadId),
    ...(query.length === 0 ? {} : { query }),
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
