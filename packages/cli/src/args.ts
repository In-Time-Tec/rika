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

export type Command =
  | ExecuteCommand
  | InteractiveCommand
  | ThreadCommand
  | SkillCommand
  | McpCommand
  | ReviewCommand
  | ExtensionCommand
  | ServerCommand

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
  "  rika skills list",
  "  rika skills inspect <name>",
  "  rika mcp list",
  "  rika mcp approve <server-name>",
  "  rika review [--staged] [--base <ref>] [--workspace <path>] [--ephemeral] [paths...]",
  "  rika extensions create-skill <name> --description <text> [--instructions <text>] [--thread <id>]",
  "  rika extensions create-plugin <name> --description <text> [--thread <id>]",
  "  rika extensions enable-plugin <name> --verification <command> [--thread <id>]",
  "  rika extensions disable-plugin <name> [--reason <text>] [--thread <id>]",
  "  rika extensions rollback-plugin <name> [--reason <text>] [--thread <id>]",
  "  rika server [--host <host>] [--port <n>] [--token <token>] [--workspace <path>] [--ephemeral]",
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

const skillNameConfig = {
  name: Argument.string("name").pipe(Argument.withDescription("Skill name")),
}

const mcpServerConfig = {
  serverName: Argument.string("server-name").pipe(Argument.withDescription("MCP server name")),
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
  const skills = makeSkillsCommand(parsedRef, rejectedRef)
  const mcp = makeMcpCommand(parsedRef, rejectedRef)
  const review = makeReviewCommand(parsedRef)
  const extensions = makeExtensionsCommand(parsedRef, rejectedRef)
  const server = makeServerCommand(parsedRef)

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
    CliCommand.withSubcommands([run, interactive, threads, skills, mcp, review, extensions, server]),
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
