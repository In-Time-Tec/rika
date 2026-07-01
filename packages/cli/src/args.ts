import { NodeServices } from "@effect/platform-node"
import { Config } from "@rika/core"
import { Ide, Ids } from "@rika/schema"
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

export const SkillAction = Schema.Literals(["list", "inspect"]).annotate({
  identifier: "Rika.Cli.Args.SkillAction",
})
export type SkillAction = typeof SkillAction.Type

export interface SkillCommand extends Schema.Schema.Type<typeof SkillCommand> {}
export const SkillCommand = Schema.Struct({
  type: Schema.Literal("skills"),
  action: SkillAction,
  name: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Cli.Args.SkillCommand" })

export const McpAction = Schema.Literals(["list", "approve"]).annotate({
  identifier: "Rika.Cli.Args.McpAction",
})
export type McpAction = typeof McpAction.Type

export interface McpCommand extends Schema.Schema.Type<typeof McpCommand> {}
export const McpCommand = Schema.Struct({
  type: Schema.Literal("mcp"),
  action: McpAction,
  server_name: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Cli.Args.McpCommand" })

export const ConfigAction = Schema.Literals(["keymap"]).annotate({
  identifier: "Rika.Cli.Args.ConfigAction",
})
export type ConfigAction = typeof ConfigAction.Type

export interface ConfigCommand extends Schema.Schema.Type<typeof ConfigCommand> {}
export const ConfigCommand = Schema.Struct({
  type: Schema.Literal("config"),
  action: ConfigAction,
}).annotate({ identifier: "Rika.Cli.Args.ConfigCommand" })

export interface VersionCommand extends Schema.Schema.Type<typeof VersionCommand> {}
export const VersionCommand = Schema.Struct({
  type: Schema.Literal("version"),
}).annotate({ identifier: "Rika.Cli.Args.VersionCommand" })

export interface HelpCommand extends Schema.Schema.Type<typeof HelpCommand> {}
export const HelpCommand = Schema.Struct({
  type: Schema.Literal("help"),
  topic: Schema.optional(
    Schema.Literals([
      "clone",
      "config",
      "config-edit",
      "config-keymap",
      "last",
      "login",
      "logout",
      "mcp",
      "mcp-add",
      "mcp-approve",
      "mcp-doctor",
      "mcp-list",
      "mcp-oauth",
      "mcp-oauth-login",
      "mcp-oauth-logout",
      "mcp-oauth-status",
      "mcp-remove",
      "threads",
      "threads-continue",
      "threads-label",
      "threads-list",
      "threads-new",
      "threads-search",
      "threads-share",
      "threads-usage",
      "threads-visibility",
      "top",
      "version",
    ]),
  ),
}).annotate({ identifier: "Rika.Cli.Args.HelpCommand" })

export interface InvalidExecuteAliasCommand extends Schema.Schema.Type<typeof InvalidExecuteAliasCommand> {}
export const InvalidExecuteAliasCommand = Schema.Struct({
  type: Schema.Literal("invalid_execute_alias"),
}).annotate({ identifier: "Rika.Cli.Args.InvalidExecuteAliasCommand" })

export interface ReviewCommand extends Schema.Schema.Type<typeof ReviewCommand> {}
export const ReviewCommand = Schema.Struct({
  type: Schema.Literal("review"),
  workspace_root: Schema.optional(Schema.String),
  staged: Schema.Boolean,
  base_ref: Schema.optional(Schema.String),
  paths: Schema.Array(Schema.String),
  ephemeral: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Args.ReviewCommand" })

export const ExtensionAction = Schema.Literals([
  "create-skill",
  "create-plugin",
  "enable-plugin",
  "disable-plugin",
  "rollback-plugin",
]).annotate({ identifier: "Rika.Cli.Args.ExtensionAction" })
export type ExtensionAction = typeof ExtensionAction.Type

export interface ExtensionCommand extends Schema.Schema.Type<typeof ExtensionCommand> {}
export const ExtensionCommand = Schema.Struct({
  type: Schema.Literal("extensions"),
  action: ExtensionAction,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  instructions: Schema.optional(Schema.String),
  verification_command: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  thread_id: Schema.optional(Ids.ThreadId),
}).annotate({ identifier: "Rika.Cli.Args.ExtensionCommand" })

export interface ServerCommand extends Schema.Schema.Type<typeof ServerCommand> {}
export const ServerCommand = Schema.Struct({
  type: Schema.Literal("server"),
  host: Schema.optional(Schema.String),
  port: Schema.optional(Schema.Int),
  token: Schema.optional(Schema.String),
  workspace_root: Schema.optional(Schema.String),
  ephemeral: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Args.ServerCommand" })

export const IdeAction = Schema.Literals(["status", "connect", "disconnect", "open-file"]).annotate({
  identifier: "Rika.Cli.Args.IdeAction",
})
export type IdeAction = typeof IdeAction.Type

export interface IdeCommand extends Schema.Schema.Type<typeof IdeCommand> {}
export const IdeCommand = Schema.Struct({
  type: Schema.Literal("ide"),
  action: IdeAction,
  server_url: Schema.optional(Schema.String),
  token: Schema.optional(Schema.String),
  client_id: Schema.optional(Ids.IdeClientId),
  name: Schema.optional(Schema.String),
  workspace_roots: Schema.optional(Schema.Array(Schema.String)),
  capabilities: Schema.optional(Schema.Array(Ide.Capability)),
  initial_context: Schema.optional(Ide.ContextSnapshot),
  open_file: Schema.optional(Ide.OpenFileRequest),
}).annotate({ identifier: "Rika.Cli.Args.IdeCommand" })

export interface InspectCommand extends Schema.Schema.Type<typeof InspectCommand> {}
export const InspectCommand = Schema.Struct({
  type: Schema.Literal("inspect"),
  all: Schema.Boolean,
  thread_id: Schema.optional(Ids.ThreadId),
}).annotate({ identifier: "Rika.Cli.Args.InspectCommand" })

export interface DoctorCommand extends Schema.Schema.Type<typeof DoctorCommand> {}
export const DoctorCommand = Schema.Struct({
  type: Schema.Literal("doctor"),
}).annotate({ identifier: "Rika.Cli.Args.DoctorCommand" })

export type Command =
  | ExecuteCommand
  | InteractiveCommand
  | ThreadCommand
  | SkillCommand
  | McpCommand
  | ConfigCommand
  | VersionCommand
  | HelpCommand
  | InvalidExecuteAliasCommand
  | ReviewCommand
  | ExtensionCommand
  | ServerCommand
  | IdeCommand
  | DoctorCommand
  | InspectCommand

export class ArgsError extends Schema.TaggedErrorClass<ArgsError>()("ArgsError", {
  message: Schema.String,
  exit_code: Schema.Int,
  usage: Schema.optional(Schema.String),
}) {}

export const invalidExecuteAliasErrorText = "Error: error: unknown option '-e'\n\u001b[=0u\u001b[<u\u001b[?25h"

export const usage = [
  "Usage:",
  "  rika [options]",
  "  rika version",
  "  rika interactive [options]",
  "  rika threads list [--include-archived] [--limit <n>]",
  "  rika threads search [--include-archived] [--limit <n>] <query>",
  "  rika threads archive <thread-id>",
  "  rika threads unarchive <thread-id>",
  "  rika threads share <thread-id>",
  "  rika threads reference <thread-id> [query]",
  "  rika skills list",
  "  rika skills inspect <name>",
  "  rika mcp list",
  "  rika mcp approve <server-name>",
  "  rika config keymap",
  "  rika review [--staged] [--base <ref>] [--workspace <path>] [--ephemeral] [paths...]",
  "  rika extensions create-skill <name> --description <text> [--instructions <text>] [--thread <id>]",
  "  rika extensions create-plugin <name> --description <text> [--thread <id>]",
  "  rika extensions enable-plugin <name> --verification <command> [--thread <id>]",
  "  rika extensions disable-plugin <name> [--reason <text>] [--thread <id>]",
  "  rika extensions rollback-plugin <name> [--reason <text>] [--thread <id>]",
  "  rika server [--host <host>] [--port <n>] [--token <token>] [--workspace <path>] [--ephemeral]",
  "  rika doctor",
  "  rika inspect --all",
  "  rika inspect --thread <thread-id>",
  "  rika ide status [--server <url>] [--token <token>]",
  "  rika ide connect --client <id> [--server <url>] [--token <token>] [--workspace <path>] [--capabilities <csv>]",
  "  rika ide disconnect --client <id> [--server <url>] [--token <token>]",
  "  rika ide open-file --path <path> [--start-line <n> --end-line <n>] [--server <url>] [--token <token>]",
  "  rika run [options] <prompt>",
  "  rika --execute [options] <prompt>",
  "",
  "Options:",
  "  -V, --version          Print the version number and exit",
  "  -v                     Alias for --version",
  "  -x, --execute           Run one non-interactive turn",
  "  -m, --mode <rush|smart|deep1|deep2|deep3> Select agent mode",
  "  --workspace <path>      Workspace root for the turn",
  "  --thread <id>           Reuse a durable thread id",
  "  --ephemeral            Use in-memory persistence for this run",
  "  -h, --help             Show this help",
].join("\n")

export const parse = Effect.fn("Cli.Args.parse")(function* (argv: ReadonlyArray<string>) {
  const helpCommand = toHelpCommand(argv)
  if (helpCommand !== undefined) return helpCommand

  const invalidExecuteAliasCommand = toInvalidExecuteAliasCommand(argv)
  if (invalidExecuteAliasCommand !== undefined) return invalidExecuteAliasCommand

  const versionCommand = toVersionCommand(argv)
  if (versionCommand !== undefined) return versionCommand

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
  mode: Flag.choice("mode", ["rush", "smart", "deep1", "deep2", "deep3"]).pipe(
    Flag.withAlias("m"),
    Flag.optional,
    Flag.withDescription("Select agent mode"),
  ),
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
  execute: Flag.boolean("execute").pipe(Flag.withAlias("x"), Flag.withDescription("Run one non-interactive turn")),
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

const skillNameConfig = {
  name: Argument.string("name").pipe(Argument.withDescription("Skill name")),
}

const mcpServerConfig = {
  serverName: Argument.string("server-name").pipe(Argument.withDescription("MCP server name")),
}

const inspectConfig = {
  all: Flag.boolean("all").pipe(Flag.withDescription("Open Rika Inspect for all telemetry")),
  thread: Flag.string("thread").pipe(Flag.optional, Flag.withDescription("Open Rika Inspect for one thread id")),
}

const reviewConfig = {
  workspace: Flag.string("workspace").pipe(Flag.optional, Flag.withDescription("Workspace root for the review")),
  staged: Flag.boolean("staged").pipe(Flag.withDescription("Review only staged changes")),
  base: Flag.string("base").pipe(Flag.optional, Flag.withDescription("Review changes since base ref")),
  ephemeral: Flag.boolean("ephemeral").pipe(Flag.withDescription("Use in-memory persistence for this review")),
  paths: Argument.string("paths").pipe(
    Argument.variadic({ min: 0 }),
    Argument.withDescription("Optional paths to limit review scope"),
  ),
}

const extensionCreateConfig = {
  name: Argument.string("name").pipe(Argument.withDescription("Extension name")),
  description: Flag.string("description").pipe(Flag.withDescription("Extension description")),
  thread: Flag.string("thread").pipe(Flag.optional, Flag.withDescription("Thread id for the artifact")),
}

const extensionCreateSkillConfig = {
  ...extensionCreateConfig,
  instructions: Flag.string("instructions").pipe(Flag.optional, Flag.withDescription("Initial skill instructions")),
}

const extensionEnableConfig = {
  name: Argument.string("name").pipe(Argument.withDescription("Plugin name")),
  verification: Flag.string("verification").pipe(Flag.withDescription("Verification command required before enabling")),
  thread: Flag.string("thread").pipe(Flag.optional, Flag.withDescription("Thread id for the artifact")),
}

const extensionDisableConfig = {
  name: Argument.string("name").pipe(Argument.withDescription("Plugin name")),
  reason: Flag.string("reason").pipe(Flag.optional, Flag.withDescription("Trust or rollback reason")),
  thread: Flag.string("thread").pipe(Flag.optional, Flag.withDescription("Thread id for the artifact")),
}

const serverConfig = {
  host: Flag.string("host").pipe(Flag.optional, Flag.withDescription("Host interface for the local server")),
  port: Flag.integer("port").pipe(Flag.optional, Flag.withDescription("Port for the local server")),
  token: Flag.string("token").pipe(Flag.optional, Flag.withDescription("Bearer token required for API calls")),
  workspace: Flag.string("workspace").pipe(Flag.optional, Flag.withDescription("Workspace root for remote turns")),
  ephemeral: Flag.boolean("ephemeral").pipe(Flag.withDescription("Use in-memory persistence for this server")),
}

const ideServerConfig = {
  server: Flag.string("server").pipe(Flag.optional, Flag.withDescription("Remote-control server URL")),
  token: Flag.string("token").pipe(Flag.optional, Flag.withDescription("Bearer token for the remote-control server")),
}

const ideConnectConfig = {
  ...ideServerConfig,
  client: Flag.string("client").pipe(Flag.withDescription("IDE client id")),
  name: Flag.string("name").pipe(Flag.optional, Flag.withDescription("IDE client display name")),
  workspace: Flag.string("workspace").pipe(Flag.optional, Flag.withDescription("Workspace root opened in the IDE")),
  capabilities: Flag.string("capabilities").pipe(
    Flag.optional,
    Flag.withDescription("Comma-separated IDE capabilities"),
  ),
  activeFile: Flag.string("active-file").pipe(Flag.optional, Flag.withDescription("Active file path")),
  startLine: Flag.integer("start-line").pipe(Flag.optional, Flag.withDescription("Selection start line")),
  endLine: Flag.integer("end-line").pipe(Flag.optional, Flag.withDescription("Selection end line")),
  selectedText: Flag.string("selected-text").pipe(Flag.optional, Flag.withDescription("Selected text")),
}

const ideDisconnectConfig = {
  ...ideServerConfig,
  client: Flag.string("client").pipe(Flag.withDescription("IDE client id")),
}

const ideOpenFileConfig = {
  ...ideServerConfig,
  path: Flag.string("path").pipe(Flag.withDescription("File path to open in the connected IDE")),
  startLine: Flag.integer("start-line").pipe(Flag.optional, Flag.withDescription("Start line to reveal")),
  endLine: Flag.integer("end-line").pipe(Flag.optional, Flag.withDescription("End line to reveal")),
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

interface SkillNameInput {
  readonly name: string
}

interface McpServerInput {
  readonly serverName: string
}

interface ReviewInput {
  readonly workspace: Option.Option<string>
  readonly staged: boolean
  readonly base: Option.Option<string>
  readonly paths: ReadonlyArray<string>
  readonly ephemeral: boolean
}

interface ExtensionCreateInput {
  readonly name: string
  readonly description: string
  readonly thread: Option.Option<string>
}

interface ExtensionCreateSkillInput extends ExtensionCreateInput {
  readonly instructions: Option.Option<string>
}

interface ExtensionEnableInput {
  readonly name: string
  readonly verification: string
  readonly thread: Option.Option<string>
}

interface ExtensionDisableInput {
  readonly name: string
  readonly reason: Option.Option<string>
  readonly thread: Option.Option<string>
}

interface ServerInput {
  readonly host: Option.Option<string>
  readonly port: Option.Option<number>
  readonly token: Option.Option<string>
  readonly workspace: Option.Option<string>
  readonly ephemeral: boolean
}

interface IdeServerInput {
  readonly server: Option.Option<string>
  readonly token: Option.Option<string>
}

interface IdeConnectInput extends IdeServerInput {
  readonly client: string
  readonly name: Option.Option<string>
  readonly workspace: Option.Option<string>
  readonly capabilities: Option.Option<string>
  readonly activeFile: Option.Option<string>
  readonly startLine: Option.Option<number>
  readonly endLine: Option.Option<number>
  readonly selectedText: Option.Option<string>
}

interface IdeDisconnectInput extends IdeServerInput {
  readonly client: string
}

interface IdeOpenFileInput extends IdeServerInput {
  readonly path: string
  readonly startLine: Option.Option<number>
  readonly endLine: Option.Option<number>
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

  const version = makeVersionCommand(parsedRef)
  const threads = makeThreadsCommand(parsedRef, rejectedRef)
  const skills = makeSkillsCommand(parsedRef, rejectedRef)
  const mcp = makeMcpCommand(parsedRef, rejectedRef)
  const config = makeConfigCommand(parsedRef, rejectedRef)
  const review = makeReviewCommand(parsedRef)
  const extensions = makeExtensionsCommand(parsedRef, rejectedRef)
  const server = makeServerCommand(parsedRef)
  const ide = makeIdeCommand(parsedRef)
  const doctor = makeDoctorCommand(parsedRef)
  const inspect = makeInspectCommand(parsedRef, rejectedRef)

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
    CliCommand.withSubcommands([
      version,
      run,
      interactive,
      threads,
      skills,
      mcp,
      config,
      review,
      extensions,
      server,
      doctor,
      inspect,
      ide,
    ]),
  )
}

const makeVersionCommand = (parsedRef: Ref.Ref<Option.Option<Command>>) =>
  CliCommand.make("version", {}, () => Ref.set(parsedRef, Option.some(toVersionCommandValue()))).pipe(
    CliCommand.withDescription("Print the version number and exit"),
    CliCommand.withShortDescription("Print version"),
  )

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

const makeSkillsCommand = (
  parsedRef: Ref.Ref<Option.Option<Command>>,
  rejectedRef: Ref.Ref<Option.Option<ArgsError>>,
) => {
  const list = CliCommand.make("list", {}, () => Ref.set(parsedRef, Option.some(toSkillListCommand()))).pipe(
    CliCommand.withDescription("List installed skills"),
    CliCommand.withShortDescription("List skills"),
  )

  const inspect = CliCommand.make("inspect", skillNameConfig, (input: SkillNameInput) =>
    Ref.set(parsedRef, Option.some(toSkillInspectCommand(input))),
  ).pipe(CliCommand.withDescription("Inspect a skill"), CliCommand.withShortDescription("Inspect skill"))

  return CliCommand.make("skills", {}, () =>
    Ref.set(rejectedRef, Option.some(new ArgsError({ message: "Expected a skills subcommand", exit_code: 2, usage }))),
  ).pipe(
    CliCommand.withDescription("List and inspect installed Rika skills"),
    CliCommand.withShortDescription("Manage skills"),
    CliCommand.withSubcommands([list, inspect]),
  )
}

const makeMcpCommand = (parsedRef: Ref.Ref<Option.Option<Command>>, rejectedRef: Ref.Ref<Option.Option<ArgsError>>) => {
  const list = CliCommand.make("list", {}, () => Ref.set(parsedRef, Option.some(toMcpListCommand()))).pipe(
    CliCommand.withDescription("List configured MCP servers and trust status"),
    CliCommand.withShortDescription("List MCP servers"),
  )

  const approve = CliCommand.make("approve", mcpServerConfig, (input: McpServerInput) =>
    Ref.set(parsedRef, Option.some(toMcpApproveCommand(input))),
  ).pipe(
    CliCommand.withDescription("Approve a workspace command MCP server"),
    CliCommand.withShortDescription("Approve MCP server"),
  )

  return CliCommand.make("mcp", {}, () =>
    Ref.set(rejectedRef, Option.some(new ArgsError({ message: "Expected an mcp subcommand", exit_code: 2, usage }))),
  ).pipe(
    CliCommand.withDescription("Manage configured MCP servers"),
    CliCommand.withShortDescription("Manage MCP"),
    CliCommand.withSubcommands([list, approve]),
  )
}

const makeConfigCommand = (
  parsedRef: Ref.Ref<Option.Option<Command>>,
  rejectedRef: Ref.Ref<Option.Option<ArgsError>>,
) => {
  const keymap = CliCommand.make("keymap", {}, () => Ref.set(parsedRef, Option.some(toConfigKeymapCommand()))).pipe(
    CliCommand.withDescription("Print effective key bindings"),
    CliCommand.withShortDescription("Print keymap"),
  )

  return CliCommand.make("config", {}, () =>
    Ref.set(rejectedRef, Option.some(new ArgsError({ message: "Expected a config subcommand", exit_code: 2, usage }))),
  ).pipe(
    CliCommand.withDescription("Inspect Rika configuration"),
    CliCommand.withShortDescription("Inspect config"),
    CliCommand.withSubcommands([keymap]),
  )
}

const makeReviewCommand = (parsedRef: Ref.Ref<Option.Option<Command>>) =>
  CliCommand.make("review", reviewConfig, (input: ReviewInput) =>
    Ref.set(parsedRef, Option.some(toReviewCommand(input))),
  ).pipe(
    CliCommand.withDescription("Review the current local diff with configured checks"),
    CliCommand.withShortDescription("Review local diff"),
  )

const makeExtensionsCommand = (
  parsedRef: Ref.Ref<Option.Option<Command>>,
  rejectedRef: Ref.Ref<Option.Option<ArgsError>>,
) => {
  const createSkill = CliCommand.make("create-skill", extensionCreateSkillConfig, (input: ExtensionCreateSkillInput) =>
    Ref.set(parsedRef, Option.some(toExtensionCreateSkillCommand(input))),
  ).pipe(CliCommand.withDescription("Create a project-local skill"), CliCommand.withShortDescription("Create skill"))

  const createPlugin = CliCommand.make("create-plugin", extensionCreateConfig, (input: ExtensionCreateInput) =>
    Ref.set(parsedRef, Option.some(toExtensionCreatePluginCommand(input))),
  ).pipe(
    CliCommand.withDescription("Create a disabled project-local plugin"),
    CliCommand.withShortDescription("Create plugin"),
  )

  const enablePlugin = CliCommand.make("enable-plugin", extensionEnableConfig, (input: ExtensionEnableInput) =>
    Ref.set(parsedRef, Option.some(toExtensionEnablePluginCommand(input))),
  ).pipe(
    CliCommand.withDescription("Enable a generated plugin after verification passes"),
    CliCommand.withShortDescription("Enable plugin"),
  )

  const disablePlugin = CliCommand.make("disable-plugin", extensionDisableConfig, (input: ExtensionDisableInput) =>
    Ref.set(parsedRef, Option.some(toExtensionDisablePluginCommand("disable-plugin", input))),
  ).pipe(CliCommand.withDescription("Disable a local plugin"), CliCommand.withShortDescription("Disable plugin"))

  const rollbackPlugin = CliCommand.make("rollback-plugin", extensionDisableConfig, (input: ExtensionDisableInput) =>
    Ref.set(parsedRef, Option.some(toExtensionDisablePluginCommand("rollback-plugin", input))),
  ).pipe(
    CliCommand.withDescription("Rollback a local plugin by disabling it"),
    CliCommand.withShortDescription("Rollback plugin"),
  )

  return CliCommand.make("extensions", {}, () =>
    Ref.set(
      rejectedRef,
      Option.some(new ArgsError({ message: "Expected an extensions subcommand", exit_code: 2, usage })),
    ),
  ).pipe(
    CliCommand.withDescription("Create, verify, enable, disable, and rollback Rika extensions"),
    CliCommand.withShortDescription("Manage extensions"),
    CliCommand.withSubcommands([createSkill, createPlugin, enablePlugin, disablePlugin, rollbackPlugin]),
  )
}

const makeServerCommand = (parsedRef: Ref.Ref<Option.Option<Command>>) =>
  CliCommand.make("server", serverConfig, (input: ServerInput) =>
    Ref.set(parsedRef, Option.some(toServerCommand(input))),
  ).pipe(
    CliCommand.withDescription("Start the local Rika remote-control server"),
    CliCommand.withShortDescription("Start remote-control server"),
  )

const makeDoctorCommand = (parsedRef: Ref.Ref<Option.Option<Command>>) =>
  CliCommand.make("doctor", {}, () => Ref.set(parsedRef, Option.some(toDoctorCommand()))).pipe(
    CliCommand.withDescription("Print local diagnostics without uploading telemetry"),
    CliCommand.withShortDescription("Print diagnostics"),
  )

const makeInspectCommand = (
  parsedRef: Ref.Ref<Option.Option<Command>>,
  rejectedRef: Ref.Ref<Option.Option<ArgsError>>,
) =>
  CliCommand.make("inspect", inspectConfig, (input: InspectInput) => {
    const command = toInspectCommand(input)
    return command === undefined
      ? Ref.set(
          rejectedRef,
          Option.some(
            new ArgsError({ message: "Expected exactly one of --all or --thread <thread-id>", exit_code: 2, usage }),
          ),
        )
      : Ref.set(parsedRef, Option.some(command))
  }).pipe(
    CliCommand.withDescription("Open Rika Inspect telemetry"),
    CliCommand.withShortDescription("Open telemetry inspector"),
  )

const makeIdeCommand = (parsedRef: Ref.Ref<Option.Option<Command>>) => {
  const status = CliCommand.make("status", ideServerConfig, (input: IdeServerInput) =>
    Ref.set(parsedRef, Option.some(toIdeStatusCommand(input))),
  ).pipe(CliCommand.withDescription("Show connected IDE status"), CliCommand.withShortDescription("Show IDE status"))

  const connect = CliCommand.make("connect", ideConnectConfig, (input: IdeConnectInput) =>
    Ref.set(parsedRef, Option.some(toIdeConnectCommand(input))),
  ).pipe(CliCommand.withDescription("Connect an IDE client"), CliCommand.withShortDescription("Connect IDE"))

  const disconnect = CliCommand.make("disconnect", ideDisconnectConfig, (input: IdeDisconnectInput) =>
    Ref.set(parsedRef, Option.some(toIdeDisconnectCommand(input))),
  ).pipe(CliCommand.withDescription("Disconnect an IDE client"), CliCommand.withShortDescription("Disconnect IDE"))

  const openFile = CliCommand.make("open-file", ideOpenFileConfig, (input: IdeOpenFileInput) =>
    Ref.set(parsedRef, Option.some(toIdeOpenFileCommand(input))),
  ).pipe(CliCommand.withDescription("Request IDE file navigation"), CliCommand.withShortDescription("Open file in IDE"))

  return CliCommand.make("ide", {}, () => Ref.set(parsedRef, Option.some(toIdeStatusCommand(emptyIdeInput)))).pipe(
    CliCommand.withDescription("Connect, inspect, and command IDE clients over the remote-control server"),
    CliCommand.withShortDescription("Manage IDE connection"),
    CliCommand.withSubcommands([status, connect, disconnect, openFile]),
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

const toSkillListCommand = (): SkillCommand => ({ type: "skills", action: "list" })

const toSkillInspectCommand = (input: SkillNameInput): SkillCommand => ({
  type: "skills",
  action: "inspect",
  name: input.name,
})

const toMcpListCommand = (): McpCommand => ({ type: "mcp", action: "list" })

const toMcpApproveCommand = (input: McpServerInput): McpCommand => ({
  type: "mcp",
  action: "approve",
  server_name: input.serverName,
})

const toConfigKeymapCommand = (): ConfigCommand => ({ type: "config", action: "keymap" })

const toVersionCommandValue = (): VersionCommand => ({ type: "version" })

const toVersionCommand = (argv: ReadonlyArray<string>): VersionCommand | undefined =>
  argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V" || argv[0] === "version")
    ? toVersionCommandValue()
    : undefined

const toHelpCommand = (argv: ReadonlyArray<string>): HelpCommand | undefined =>
  argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")
    ? { type: "help" }
    : argv.length === 2 && argv[0] === "top" && (argv[1] === "--help" || argv[1] === "-h")
      ? { type: "help", topic: "top" }
      : argv.length === 2 && argv[0] === "last" && (argv[1] === "--help" || argv[1] === "-h")
        ? { type: "help", topic: "last" }
        : argv.length === 2 && argv[0] === "threads" && (argv[1] === "--help" || argv[1] === "-h")
          ? { type: "help", topic: "threads" }
          : argv.length === 3 &&
              argv[0] === "threads" &&
              argv[1] === "new" &&
              (argv[2] === "--help" || argv[2] === "-h")
            ? { type: "help", topic: "threads-new" }
            : argv.length === 3 &&
                argv[0] === "threads" &&
                argv[1] === "continue" &&
                (argv[2] === "--help" || argv[2] === "-h")
              ? { type: "help", topic: "threads-continue" }
              : argv.length === 3 &&
                  argv[0] === "threads" &&
                  argv[1] === "list" &&
                  (argv[2] === "--help" || argv[2] === "-h")
                ? { type: "help", topic: "threads-list" }
                : argv.length === 3 &&
                    argv[0] === "threads" &&
                    argv[1] === "usage" &&
                    (argv[2] === "--help" || argv[2] === "-h")
                  ? { type: "help", topic: "threads-usage" }
                  : argv.length === 3 &&
                      argv[0] === "threads" &&
                      argv[1] === "visibility" &&
                      (argv[2] === "--help" || argv[2] === "-h")
                    ? { type: "help", topic: "threads-visibility" }
                    : argv.length === 3 &&
                        argv[0] === "threads" &&
                        argv[1] === "label" &&
                        (argv[2] === "--help" || argv[2] === "-h")
                      ? { type: "help", topic: "threads-label" }
                      : argv.length === 3 &&
                          argv[0] === "threads" &&
                          argv[1] === "share" &&
                          (argv[2] === "--help" || argv[2] === "-h")
                        ? { type: "help", topic: "threads-share" }
                        : argv.length === 3 &&
                            argv[0] === "threads" &&
                            argv[1] === "search" &&
                            (argv[2] === "--help" || argv[2] === "-h")
                          ? { type: "help", topic: "threads-search" }
                          : argv.length === 2 && argv[0] === "clone" && (argv[1] === "--help" || argv[1] === "-h")
                            ? { type: "help", topic: "clone" }
                            : argv.length === 2 && argv[0] === "login" && (argv[1] === "--help" || argv[1] === "-h")
                              ? { type: "help", topic: "login" }
                              : argv.length === 2 && argv[0] === "logout" && (argv[1] === "--help" || argv[1] === "-h")
                                ? { type: "help", topic: "logout" }
                                : argv.length === 3 &&
                                    argv[0] === "config" &&
                                    argv[1] === "edit" &&
                                    (argv[2] === "--help" || argv[2] === "-h")
                                  ? { type: "help", topic: "config-edit" }
                                  : argv.length === 3 &&
                                      argv[0] === "config" &&
                                      argv[1] === "keymap" &&
                                      (argv[2] === "--help" || argv[2] === "-h")
                                    ? { type: "help", topic: "config-keymap" }
                                    : argv.length === 2 &&
                                        argv[0] === "config" &&
                                        (argv[1] === "--help" || argv[1] === "-h")
                                      ? { type: "help", topic: "config" }
                                      : argv.length === 3 &&
                                          argv[0] === "mcp" &&
                                          argv[1] === "add" &&
                                          (argv[2] === "--help" || argv[2] === "-h")
                                        ? { type: "help", topic: "mcp-add" }
                                        : argv.length === 3 &&
                                            argv[0] === "mcp" &&
                                            argv[1] === "approve" &&
                                            (argv[2] === "--help" || argv[2] === "-h")
                                          ? { type: "help", topic: "mcp-approve" }
                                          : argv.length === 3 &&
                                              argv[0] === "mcp" &&
                                              argv[1] === "doctor" &&
                                              (argv[2] === "--help" || argv[2] === "-h")
                                            ? { type: "help", topic: "mcp-doctor" }
                                            : argv.length === 3 &&
                                                argv[0] === "mcp" &&
                                                argv[1] === "list" &&
                                                (argv[2] === "--help" || argv[2] === "-h")
                                              ? { type: "help", topic: "mcp-list" }
                                              : argv.length === 4 &&
                                                  argv[0] === "mcp" &&
                                                  argv[1] === "oauth" &&
                                                  argv[2] === "login" &&
                                                  (argv[3] === "--help" || argv[3] === "-h")
                                                ? { type: "help", topic: "mcp-oauth-login" }
                                                : argv.length === 4 &&
                                                    argv[0] === "mcp" &&
                                                    argv[1] === "oauth" &&
                                                    argv[2] === "logout" &&
                                                    (argv[3] === "--help" || argv[3] === "-h")
                                                  ? { type: "help", topic: "mcp-oauth-logout" }
                                                  : argv.length === 4 &&
                                                      argv[0] === "mcp" &&
                                                      argv[1] === "oauth" &&
                                                      argv[2] === "status" &&
                                                      (argv[3] === "--help" || argv[3] === "-h")
                                                    ? { type: "help", topic: "mcp-oauth-status" }
                                                    : argv.length === 3 &&
                                                        argv[0] === "mcp" &&
                                                        argv[1] === "oauth" &&
                                                        (argv[2] === "--help" || argv[2] === "-h")
                                                      ? { type: "help", topic: "mcp-oauth" }
                                                      : argv.length === 3 &&
                                                          argv[0] === "mcp" &&
                                                          argv[1] === "remove" &&
                                                          (argv[2] === "--help" || argv[2] === "-h")
                                                        ? { type: "help", topic: "mcp-remove" }
                                                        : argv.length === 2 &&
                                                            argv[0] === "mcp" &&
                                                            (argv[1] === "--help" || argv[1] === "-h")
                                                          ? { type: "help", topic: "mcp" }
                                                          : argv.length === 2 &&
                                                              argv[0] === "version" &&
                                                              (argv[1] === "--help" || argv[1] === "-h")
                                                            ? { type: "help", topic: "version" }
                                                            : undefined

const toInvalidExecuteAliasCommand = (argv: ReadonlyArray<string>): InvalidExecuteAliasCommand | undefined =>
  argv.length === 1 && argv[0] === "-e" ? { type: "invalid_execute_alias" } : undefined

const toReviewCommand = (input: ReviewInput): ReviewCommand => {
  const workspaceRoot = Option.getOrUndefined(input.workspace)
  const baseRef = Option.getOrUndefined(input.base)
  return {
    type: "review",
    staged: input.staged,
    paths: [...input.paths],
    ephemeral: input.ephemeral,
    ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot }),
    ...(baseRef === undefined ? {} : { base_ref: baseRef }),
  }
}

const toExtensionCreateSkillCommand = (input: ExtensionCreateSkillInput): ExtensionCommand => {
  const instructions = Option.getOrUndefined(input.instructions)
  return {
    type: "extensions",
    action: "create-skill",
    name: input.name,
    description: input.description,
    ...(instructions === undefined ? {} : { instructions }),
    ...threadOption(input.thread),
  }
}

const toExtensionCreatePluginCommand = (input: ExtensionCreateInput): ExtensionCommand => ({
  type: "extensions",
  action: "create-plugin",
  name: input.name,
  description: input.description,
  ...threadOption(input.thread),
})

const toExtensionEnablePluginCommand = (input: ExtensionEnableInput): ExtensionCommand => ({
  type: "extensions",
  action: "enable-plugin",
  name: input.name,
  verification_command: input.verification,
  ...threadOption(input.thread),
})

const toExtensionDisablePluginCommand = (
  action: Extract<ExtensionAction, "disable-plugin" | "rollback-plugin">,
  input: ExtensionDisableInput,
): ExtensionCommand => {
  const reason = Option.getOrUndefined(input.reason)
  return {
    type: "extensions",
    action,
    name: input.name,
    ...(reason === undefined ? {} : { reason }),
    ...threadOption(input.thread),
  }
}

const threadOption = (thread: Option.Option<string>) => {
  const value = Option.getOrUndefined(thread)
  return value === undefined ? {} : { thread_id: Ids.ThreadId.make(value) }
}

const toServerCommand = (input: ServerInput): ServerCommand => {
  const host = Option.getOrUndefined(input.host)
  const port = Option.getOrUndefined(input.port)
  const token = Option.getOrUndefined(input.token)
  const workspaceRoot = Option.getOrUndefined(input.workspace)
  return {
    type: "server",
    ephemeral: input.ephemeral,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(token === undefined ? {} : { token }),
    ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot }),
  }
}

const toDoctorCommand = (): DoctorCommand => ({ type: "doctor" })

interface InspectInput {
  readonly all: boolean
  readonly thread: Option.Option<string>
}

const toInspectCommand = (input: InspectInput): InspectCommand | undefined => {
  const thread = Option.getOrUndefined(input.thread)
  if (input.all === (thread !== undefined)) return undefined
  return {
    type: "inspect",
    all: input.all,
    ...(thread === undefined ? {} : { thread_id: Ids.ThreadId.make(thread) }),
  }
}

const emptyIdeInput: IdeServerInput = { server: Option.none(), token: Option.none() }

const toIdeStatusCommand = (input: IdeServerInput): IdeCommand => ({
  type: "ide",
  action: "status",
  ...ideServerOptions(input),
})

const toIdeConnectCommand = (input: IdeConnectInput): IdeCommand => {
  const name = Option.getOrUndefined(input.name)
  const workspaceRoot = Option.getOrUndefined(input.workspace)
  const activeFile = Option.getOrUndefined(input.activeFile)
  const startLine = Option.getOrUndefined(input.startLine)
  const endLine = Option.getOrUndefined(input.endLine)
  const selectedText = Option.getOrUndefined(input.selectedText)
  const workspaceRoots = workspaceRoot === undefined ? [] : [workspaceRoot]
  const initialContext =
    workspaceRoot === undefined && activeFile === undefined
      ? undefined
      : ideContext(workspaceRoots, activeFile, startLine, endLine, selectedText)
  return {
    type: "ide",
    action: "connect",
    client_id: Ids.IdeClientId.make(input.client),
    workspace_roots: workspaceRoots,
    capabilities: parseCapabilities(Option.getOrUndefined(input.capabilities)),
    ...(name === undefined ? {} : { name }),
    ...(initialContext === undefined ? {} : { initial_context: initialContext }),
    ...ideServerOptions(input),
  }
}

const toIdeDisconnectCommand = (input: IdeDisconnectInput): IdeCommand => ({
  type: "ide",
  action: "disconnect",
  client_id: Ids.IdeClientId.make(input.client),
  ...ideServerOptions(input),
})

const toIdeOpenFileCommand = (input: IdeOpenFileInput): IdeCommand => ({
  type: "ide",
  action: "open-file",
  open_file: {
    path: input.path,
    ...lineRange(Option.getOrUndefined(input.startLine), Option.getOrUndefined(input.endLine)),
  },
  ...ideServerOptions(input),
})

const ideServerOptions = (input: IdeServerInput) => {
  const serverUrl = Option.getOrUndefined(input.server)
  const token = Option.getOrUndefined(input.token)
  return {
    ...(serverUrl === undefined ? {} : { server_url: serverUrl }),
    ...(token === undefined ? {} : { token }),
  }
}

const ideContext = (
  workspaceRoots: ReadonlyArray<string>,
  activeFile: string | undefined,
  startLine: number | undefined,
  endLine: number | undefined,
  selectedText: string | undefined,
): Ide.ContextSnapshot => ({
  workspace_roots: [...workspaceRoots],
  ...(activeFile === undefined
    ? {}
    : {
        active_file: {
          path: activeFile,
          ...selection(startLine, endLine, selectedText),
        },
      }),
})

const selection = (startLine: number | undefined, endLine: number | undefined, selectedText: string | undefined) => {
  if (startLine === undefined || endLine === undefined) return {}
  return {
    selection: {
      range: { start_line: startLine, end_line: endLine },
      ...(selectedText === undefined ? {} : { selected_text: selectedText }),
    },
  }
}

const lineRange = (startLine: number | undefined, endLine: number | undefined) =>
  startLine === undefined || endLine === undefined ? {} : { range: { start_line: startLine, end_line: endLine } }

const parseCapabilities = (value: string | undefined): ReadonlyArray<Ide.Capability> => {
  if (value === undefined || value.trim().length === 0) return ["active-context", "diagnostics", "navigation"]
  return value
    .split(",")
    .map((capability) => capability.trim())
    .filter(
      (capability): capability is Ide.Capability =>
        capability === "active-context" || capability === "diagnostics" || capability === "navigation",
    )
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
