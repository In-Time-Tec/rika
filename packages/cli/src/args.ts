import { NodeServices } from "@effect/platform-node"
import { Config } from "@rika/core"
import { Common, Ide, Ids } from "@rika/schema"
import { Console, Effect, Option, Ref, Schema } from "effect"
import { Argument, CliError, Command as CliCommand, Flag } from "effect/unstable/cli"

export interface ExecuteCommand extends Schema.Schema.Type<typeof ExecuteCommand> {}
export const ExecuteCommand = Schema.Struct({
  type: Schema.Literal("execute"),
  prompt: Schema.String,
  orb: Schema.Boolean,
  stream_json: Schema.Boolean,
  stream_json_input: Schema.Boolean,
  mode: Schema.optional(Config.Mode),
  project_name: Schema.optional(Schema.String),
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
  orb: Schema.Boolean,
  ephemeral: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Args.InteractiveCommand" })

export const ThreadAction = Schema.Literals([
  "list",
  "search",
  "archive",
  "unarchive",
  "compact",
  "fork",
  "visibility",
  "tournament",
  "share",
  "reference",
  "delete",
  "rebuild-projection",
  "import",
]).annotate({ identifier: "Rika.Cli.Args.ThreadAction" })
export type ThreadAction = typeof ThreadAction.Type

export interface ThreadCommand extends Schema.Schema.Type<typeof ThreadCommand> {}
export const ThreadCommand = Schema.Struct({
  type: Schema.Literal("threads"),
  action: ThreadAction,
  thread_id: Schema.optional(Ids.ThreadId),
  query: Schema.optional(Schema.String),
  at_turn: Schema.optional(Ids.TurnId),
  visibility: Schema.optional(Schema.Literals(["private", "workspace", "unlisted"])),
  message: Schema.optional(Schema.String),
  branch_count: Schema.optional(Schema.Int),
  modes: Schema.optional(Schema.Array(Config.Mode)),
  rubric: Schema.optional(Schema.String),
  include_archived: Schema.optional(Schema.Boolean),
  limit: Schema.optional(Schema.Int),
  semantic: Schema.optional(Schema.Boolean),
  source_data_dir: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Cli.Args.ThreadCommand" })

export const ProjectAction = Schema.Literals(["create", "list", "show", "set-env", "set-secret"]).annotate({
  identifier: "Rika.Cli.Args.ProjectAction",
})
export type ProjectAction = typeof ProjectAction.Type

export interface ProjectCommand extends Schema.Schema.Type<typeof ProjectCommand> {}
export const ProjectCommand = Schema.Struct({
  type: Schema.Literal("project"),
  action: ProjectAction,
  name: Schema.optional(Schema.String),
  repo_origin: Schema.optional(Schema.String),
  default_branch: Schema.optional(Schema.String),
  template_id: Schema.optional(Schema.String),
  env_assignment: Schema.optional(Schema.String),
  secret_name: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Cli.Args.ProjectCommand" })

export const SkillAction = Schema.Literals(["list", "inspect", "add", "remove"]).annotate({
  identifier: "Rika.Cli.Args.SkillAction",
})
export type SkillAction = typeof SkillAction.Type

export interface SkillCommand extends Schema.Schema.Type<typeof SkillCommand> {}
export const SkillCommand = Schema.Struct({
  type: Schema.Literal("skills"),
  action: SkillAction,
  name: Schema.optional(Schema.String),
  source: Schema.optional(Schema.String),
  user: Schema.optional(Schema.Boolean),
  force: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Rika.Cli.Args.SkillCommand" })

export const McpAction = Schema.Literals(["list", "approve", "add", "remove", "doctor"]).annotate({
  identifier: "Rika.Cli.Args.McpAction",
})
export type McpAction = typeof McpAction.Type

export interface McpCommand extends Schema.Schema.Type<typeof McpCommand> {}
export const McpCommand = Schema.Struct({
  type: Schema.Literal("mcp"),
  action: McpAction,
  server_name: Schema.optional(Schema.String),
  global: Schema.optional(Schema.Boolean),
  url: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "Rika.Cli.Args.McpCommand" })

export const ConfigAction = Schema.Literals(["keymap", "list", "edit"]).annotate({
  identifier: "Rika.Cli.Args.ConfigAction",
})
export type ConfigAction = typeof ConfigAction.Type

export interface ConfigCommand extends Schema.Schema.Type<typeof ConfigCommand> {}
export const ConfigCommand = Schema.Struct({
  type: Schema.Literal("config"),
  action: ConfigAction,
  workspace: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Rika.Cli.Args.ConfigCommand" })

export const OrbAction = Schema.Literals(["list", "kill", "shell", "usage", "tournament"]).annotate({
  identifier: "Rika.Cli.Args.OrbAction",
})
export type OrbAction = typeof OrbAction.Type

export interface OrbCommand extends Schema.Schema.Type<typeof OrbCommand> {}
export const OrbCommand = Schema.Struct({
  type: Schema.Literal("orb"),
  action: OrbAction,
  thread_id: Schema.optional(Ids.ThreadId),
  force: Schema.optional(Schema.Boolean),
  project_name: Schema.optional(Schema.String),
  since: Schema.optional(Common.TimestampMillis),
  task: Schema.optional(Schema.String),
  branch_count: Schema.optional(Schema.Int),
  modes: Schema.optional(Schema.Array(Config.Mode)),
  rubric: Schema.optional(Schema.String),
  sync_winner: Schema.optional(Schema.Boolean),
  keep_losers: Schema.optional(Schema.Boolean),
  yes: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Rika.Cli.Args.OrbCommand" })

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
      "threads-fork",
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
  orb: Schema.Boolean,
  base_commit: Schema.optional(Schema.String),
  ephemeral: Schema.Boolean,
}).annotate({ identifier: "Rika.Cli.Args.ServerCommand" })

export interface SyncCommand extends Schema.Schema.Type<typeof SyncCommand> {}
export const SyncCommand = Schema.Struct({
  type: Schema.Literal("sync"),
  thread_id: Ids.ThreadId,
}).annotate({ identifier: "Rika.Cli.Args.SyncCommand" })

export const MemoryAction = Schema.Literals(["index", "status"]).annotate({
  identifier: "Rika.Cli.Args.MemoryAction",
})
export type MemoryAction = typeof MemoryAction.Type

export interface MemoryCommand extends Schema.Schema.Type<typeof MemoryCommand> {}
export const MemoryCommand = Schema.Struct({
  type: Schema.Literal("memory"),
  action: MemoryAction,
  workspace_root: Schema.optional(Schema.String),
}).annotate({ identifier: "Rika.Cli.Args.MemoryCommand" })

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

export interface DoctorCommand extends Schema.Schema.Type<typeof DoctorCommand> {}
export const DoctorCommand = Schema.Struct({
  type: Schema.Literal("doctor"),
}).annotate({ identifier: "Rika.Cli.Args.DoctorCommand" })

export type Command =
  | ExecuteCommand
  | InteractiveCommand
  | ThreadCommand
  | ProjectCommand
  | SkillCommand
  | McpCommand
  | ConfigCommand
  | OrbCommand
  | VersionCommand
  | HelpCommand
  | InvalidExecuteAliasCommand
  | ReviewCommand
  | ExtensionCommand
  | ServerCommand
  | SyncCommand
  | MemoryCommand
  | IdeCommand
  | DoctorCommand

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
  "  rika threads search [--semantic] [--include-archived] [--limit <n>] <query>",
  "  rika threads archive <thread-id>",
  "  rika threads unarchive <thread-id>",
  "  rika threads visibility <thread-id> <private|workspace|unlisted>",
  "  rika threads fork <thread-id> [--at-turn <turn-id>]",
  "  rika threads tournament <thread-id> --message <text|-> -n <2..4> [--modes smart,deep2,deep3] [--rubric <text>]",
  "  rika threads share <thread-id>",
  "  rika threads reference <thread-id> [query]",
  "  rika threads rebuild-projection",
  "  rika threads import <source-data-dir>",
  "  rika project create <name> [--repo <origin>] [--branch <branch>] [--template <id>]",
  "  rika project list",
  "  rika project show <name>",
  "  rika project set-env <name> KEY=VALUE",
  "  rika project set-secret <name> KEY",
  "  rika skills list",
  "  rika skills inspect <name>",
  "  rika mcp list",
  "  rika mcp add <name> [--global] [--url <url> | -- <command> [args...]]",
  "  rika mcp remove <name> [--global]",
  "  rika mcp doctor",
  "  rika mcp approve <server-name>",
  "  rika config list",
  "  rika config keymap",
  "  rika config edit [--workspace]",
  "  rika orb list",
  "  rika orb usage [--project <name>] [--since <iso-date>]",
  "  rika orb tournament <task> -n <2..4> [--project <name>] [--modes smart,deep2,deep3] [--rubric <text>] [--sync-winner]",
  "  rika orb kill <thread-id> [--force]",
  "  rika orb shell <thread-id>",
  "  rika review [--staged] [--base <ref>] [--workspace <path>] [--ephemeral] [paths...]",
  "  rika extensions create-skill <name> --description <text> [--instructions <text>] [--thread <id>]",
  "  rika extensions create-plugin <name> --description <text> [--thread <id>]",
  "  rika extensions enable-plugin <name> --verification <command> [--thread <id>]",
  "  rika extensions disable-plugin <name> [--reason <text>] [--thread <id>]",
  "  rika extensions rollback-plugin <name> [--reason <text>] [--thread <id>]",
  "  rika server [--host <host>] [--port <n>] [--token <token>] [--workspace <path>] [--orb --base-commit <sha>] [--ephemeral]",
  "  rika sync <thread-id>",
  "  rika memory index [--workspace <path>]",
  "  rika memory status",
  "  rika doctor",
  "  rika ide status [--server <url>] [--token <token>]",
  "  rika ide connect --client <id> [--server <url>] [--token <token>] [--workspace <path>] [--capabilities <csv>]",
  "  rika ide disconnect --client <id> [--server <url>] [--token <token>]",
  "  rika ide open-file --path <path> [--start-line <n> --end-line <n>] [--server <url>] [--token <token>]",
  "  rika run [options] [prompt]",
  "  rika --execute [options] [prompt]",
  "",
  "Options:",
  "  -V, --version          Print the version number and exit",
  "  -v                     Alias for --version",
  "  -x, --execute           Run one non-interactive turn",
  "  -m, --mode <rush|smart|deep1|deep2|deep3> Select agent mode",
  "  --workspace <path>      Workspace root for the turn",
  "  --thread <id>           Reuse a durable thread id",
  "  --ephemeral            Use in-memory persistence for this run",
  "  --stream-json          Stream schema JSON events to stdout",
  "  --stream-json-input    Read JSON Lines user messages from stdin; requires --stream-json",
  "  -h, --help             Show this help",
].join("\n")

export const parse = Effect.fn("Cli.Args.parse")(function* (argv: ReadonlyArray<string>) {
  const helpCommand = toHelpCommand(argv)
  if (helpCommand !== undefined) return helpCommand

  const invalidExecuteAliasCommand = toInvalidExecuteAliasCommand(argv)
  if (invalidExecuteAliasCommand !== undefined) return invalidExecuteAliasCommand

  const mcpCommand = toMcpCommand(argv)
  if (mcpCommand instanceof ArgsError) return yield* mcpCommand
  if (mcpCommand !== undefined) return mcpCommand

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
  orb: Flag.boolean("orb").pipe(Flag.withAlias("o"), Flag.withDescription("Run the turn in an orb")),
  ephemeral: Flag.boolean("ephemeral").pipe(Flag.withDescription("Use in-memory persistence for this run")),
}

const executeConfig = {
  ...baseConfig,
  project: Flag.string("project").pipe(Flag.optional, Flag.withDescription("Project name for orb execution")),
  streamJson: Flag.boolean("stream-json").pipe(Flag.withDescription("Stream schema JSON events to stdout")),
  streamJsonInput: Flag.boolean("stream-json-input").pipe(
    Flag.withDescription("Read JSON Lines user messages from stdin; requires --stream-json"),
  ),
  prompt: Argument.string("prompt").pipe(
    Argument.variadic({ min: 0 }),
    Argument.withDescription("Prompt text to send to the agent"),
  ),
}

const rootConfig = {
  execute: Flag.boolean("execute").pipe(Flag.withAlias("x"), Flag.withDescription("Run one non-interactive turn")),
  ...baseConfig,
  project: Flag.string("project").pipe(Flag.optional, Flag.withDescription("Project name for orb execution")),
  streamJson: Flag.boolean("stream-json").pipe(Flag.withDescription("Stream schema JSON events to stdout")),
  streamJsonInput: Flag.boolean("stream-json-input").pipe(
    Flag.withDescription("Read JSON Lines user messages from stdin; requires --stream-json"),
  ),
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
  semantic: Flag.boolean("semantic").pipe(Flag.withDescription("Use semantic thread memory search")),
  query: Argument.string("query").pipe(Argument.variadic({ min: 1 }), Argument.withDescription("Search terms")),
}

const threadIdConfig = {
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id")),
}

const threadForkConfig = {
  ...threadIdConfig,
  atTurn: Flag.string("at-turn").pipe(Flag.optional, Flag.withDescription("Fork through the completed turn id")),
}

const threadVisibilityConfig = {
  ...threadIdConfig,
  visibility: Argument.string("visibility").pipe(Argument.withDescription("private, workspace, or unlisted")),
}

const threadTournamentConfig = {
  ...threadIdConfig,
  message: Flag.string("message").pipe(Flag.withDescription("Tournament instruction; use - to read stdin")),
  branchCount: Flag.integer("branches").pipe(
    Flag.withAlias("n"),
    Flag.withDescription("Number of tournament branches"),
  ),
  modes: Flag.string("modes").pipe(Flag.optional, Flag.withDescription("Comma-separated branch modes")),
  rubric: Flag.string("rubric").pipe(Flag.optional, Flag.withDescription("Additional judging rubric")),
}

const threadReferenceConfig = {
  ...threadIdConfig,
  query: Argument.string("query").pipe(
    Argument.variadic({ min: 0 }),
    Argument.withDescription("Optional reference query"),
  ),
}

const threadImportConfig = {
  source: Argument.string("source-data-dir").pipe(
    Argument.withDescription("Rika data directory containing rika.sqlite"),
  ),
}

const projectCreateConfig = {
  name: Argument.string("name").pipe(Argument.withDescription("Project name")),
  repo: Flag.string("repo").pipe(Flag.optional, Flag.withDescription("Repository origin URL")),
  branch: Flag.string("branch").pipe(Flag.optional, Flag.withDescription("Default branch")),
  template: Flag.string("template").pipe(Flag.optional, Flag.withDescription("Sandbox template id")),
}

const projectNameConfig = {
  name: Argument.string("name").pipe(Argument.withDescription("Project name")),
}

const projectSetEnvConfig = {
  ...projectNameConfig,
  assignment: Argument.string("KEY=VALUE").pipe(Argument.withDescription("Environment variable assignment")),
}

const projectSetSecretConfig = {
  ...projectNameConfig,
  key: Argument.string("KEY").pipe(Argument.withDescription("Secret name")),
}

const skillNameConfig = {
  name: Argument.string("name").pipe(Argument.withDescription("Skill name")),
}

const skillAddConfig = {
  source: Argument.string("source").pipe(Argument.withDescription("GitHub source or git repository URL")),
  user: Flag.boolean("user").pipe(Flag.withDescription("Install into the user skill directory")),
  force: Flag.boolean("force").pipe(Flag.withDescription("Overwrite an existing skill")),
}

const skillRemoveConfig = {
  ...skillNameConfig,
  user: Flag.boolean("user").pipe(Flag.withDescription("Remove from the user skill directory")),
}

const mcpServerConfig = {
  serverName: Argument.string("server-name").pipe(Argument.withDescription("MCP server name")),
}

const configEditConfig = {
  workspace: Flag.boolean("workspace").pipe(Flag.withDescription("Edit workspace settings instead of user settings")),
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
  orb: Flag.boolean("orb").pipe(Flag.withDescription("Serve orb-only endpoints")),
  baseCommit: Flag.string("base-commit").pipe(Flag.optional, Flag.withDescription("Orb repository base commit")),
  ephemeral: Flag.boolean("ephemeral").pipe(Flag.withDescription("Use in-memory persistence for this server")),
}

const syncConfig = {
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id to sync from its orb")),
}

const memoryIndexConfig = {
  workspace: Flag.string("workspace").pipe(Flag.optional, Flag.withDescription("Workspace root to backfill")),
}

const orbKillConfig = {
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id")),
  force: Flag.boolean("force").pipe(Flag.withDescription("Skip confirmation")),
}

const orbShellConfig = {
  threadId: Argument.string("thread-id").pipe(Argument.withDescription("Thread id")),
}

const orbUsageConfig = {
  project: Flag.string("project").pipe(Flag.optional, Flag.withDescription("Project name")),
  since: Flag.string("since").pipe(Flag.optional, Flag.withDescription("ISO date lower bound")),
}

const orbTournamentConfig = {
  task: Argument.string("task").pipe(Argument.withDescription("Task to run in each orb")),
  branchCount: Flag.integer("branches").pipe(Flag.withAlias("n"), Flag.withDescription("Number of orb candidates")),
  project: Flag.string("project").pipe(Flag.optional, Flag.withDescription("Project name")),
  modes: Flag.string("modes").pipe(Flag.optional, Flag.withDescription("Comma-separated candidate modes")),
  rubric: Flag.string("rubric").pipe(Flag.optional, Flag.withDescription("Additional judging rubric")),
  syncWinner: Flag.boolean("sync-winner").pipe(Flag.withDescription("Sync the winning diff into a local worktree")),
  keepLosers: Flag.boolean("keep-losers").pipe(Flag.withDescription("Pause losers instead of killing them")),
  yes: Flag.boolean("yes").pipe(Flag.withDescription("Skip provisioning confirmation")),
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
  readonly orb: boolean
  readonly ephemeral: boolean
  readonly project: Option.Option<string>
  readonly streamJson: boolean
  readonly streamJsonInput: boolean
  readonly prompt: ReadonlyArray<string>
}

interface InteractiveInput {
  readonly mode: Option.Option<Config.Mode>
  readonly workspace: Option.Option<string>
  readonly thread: Option.Option<string>
  readonly orb: boolean
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
  readonly semantic: boolean
  readonly query: ReadonlyArray<string>
}

interface ThreadIdInput {
  readonly threadId: string
}

interface ThreadForkInput extends ThreadIdInput {
  readonly atTurn: Option.Option<string>
}

interface ThreadVisibilityInput extends ThreadIdInput {
  readonly visibility: string
}

interface ThreadTournamentInput extends ThreadIdInput {
  readonly message: string
  readonly branchCount: number
  readonly modes: Option.Option<string>
  readonly rubric: Option.Option<string>
}

interface ThreadReferenceInput extends ThreadIdInput {
  readonly query: ReadonlyArray<string>
}

interface ThreadImportInput {
  readonly source: string
}

interface ProjectCreateInput {
  readonly name: string
  readonly repo: Option.Option<string>
  readonly branch: Option.Option<string>
  readonly template: Option.Option<string>
}

interface ProjectNameInput {
  readonly name: string
}

interface ProjectSetEnvInput extends ProjectNameInput {
  readonly assignment: string
}

interface ProjectSetSecretInput extends ProjectNameInput {
  readonly key: string
}

interface SkillNameInput {
  readonly name: string
}

interface SkillAddInput {
  readonly source: string
  readonly user: boolean
  readonly force: boolean
}

interface SkillRemoveInput extends SkillNameInput {
  readonly user: boolean
}

interface McpServerInput {
  readonly serverName: string
}

interface ConfigEditInput {
  readonly workspace: boolean
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
  readonly orb: boolean
  readonly baseCommit: Option.Option<string>
  readonly ephemeral: boolean
}

interface SyncInput {
  readonly threadId: string
}

interface MemoryIndexInput {
  readonly workspace: Option.Option<string>
}

interface OrbKillInput {
  readonly threadId: string
  readonly force: boolean
}

interface OrbShellInput {
  readonly threadId: string
}

interface OrbUsageInput {
  readonly project: Option.Option<string>
  readonly since: Option.Option<string>
}

interface OrbTournamentInput {
  readonly task: string
  readonly branchCount: number
  readonly project: Option.Option<string>
  readonly modes: Option.Option<string>
  readonly rubric: Option.Option<string>
  readonly syncWinner: boolean
  readonly keepLosers: boolean
  readonly yes: boolean
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
    setExecuteCommand(parsedRef, rejectedRef, input),
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
  const project = makeProjectCommand(parsedRef, rejectedRef)
  const skills = makeSkillsCommand(parsedRef, rejectedRef)
  const mcp = makeMcpCommand(parsedRef, rejectedRef)
  const config = makeConfigCommand(parsedRef, rejectedRef)
  const orb = makeOrbCommand(parsedRef, rejectedRef)
  const review = makeReviewCommand(parsedRef)
  const extensions = makeExtensionsCommand(parsedRef, rejectedRef)
  const server = makeServerCommand(parsedRef)
  const sync = makeSyncCommand(parsedRef)
  const memory = makeMemoryCommand(parsedRef, rejectedRef)
  const ide = makeIdeCommand(parsedRef)
  const doctor = makeDoctorCommand(parsedRef)

  return CliCommand.make("rika", rootConfig, (input: RootInput) =>
    input.execute
      ? setExecuteCommand(parsedRef, rejectedRef, input)
      : input.streamJsonInput && !input.streamJson
        ? Ref.set(
            rejectedRef,
            Option.some(new ArgsError({ message: "--stream-json-input requires --stream-json", exit_code: 2, usage })),
          )
        : input.streamJson
          ? Ref.set(
              rejectedRef,
              Option.some(new ArgsError({ message: "--stream-json requires --execute or run", exit_code: 2, usage })),
            )
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
      project,
      skills,
      mcp,
      config,
      orb,
      review,
      extensions,
      server,
      sync,
      memory,
      doctor,
      ide,
    ]),
  )
}

const setExecuteCommand = (
  parsedRef: Ref.Ref<Option.Option<Command>>,
  rejectedRef: Ref.Ref<Option.Option<ArgsError>>,
  input: ExecuteInput,
) =>
  input.streamJsonInput && !input.streamJson
    ? Ref.set(
        rejectedRef,
        Option.some(new ArgsError({ message: "--stream-json-input requires --stream-json", exit_code: 2, usage })),
      )
    : Ref.set(parsedRef, Option.some(toExecuteCommand(input)))

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

  const compact = CliCommand.make("compact", threadIdConfig, (input: ThreadIdInput) =>
    Ref.set(parsedRef, Option.some(toThreadIdCommand("compact", input))),
  ).pipe(CliCommand.withDescription("Compact a local thread"), CliCommand.withShortDescription("Compact thread"))

  const fork = CliCommand.make("fork", threadForkConfig, (input: ThreadForkInput) =>
    Ref.set(parsedRef, Option.some(toThreadForkCommand(input))),
  ).pipe(
    CliCommand.withDescription("Fork a local thread conversation without forking the working tree"),
    CliCommand.withShortDescription("Fork thread"),
  )

  const visibility = CliCommand.make("visibility", threadVisibilityConfig, (input: ThreadVisibilityInput) => {
    const parsed = toThreadVisibilityCommand(input)
    if (parsed instanceof ArgsError) return Ref.set(rejectedRef, Option.some(parsed))
    return Ref.set(parsedRef, Option.some(parsed))
  }).pipe(
    CliCommand.withDescription("Set a local thread visibility level"),
    CliCommand.withShortDescription("Set thread visibility"),
  )

  const tournament = CliCommand.make("tournament", threadTournamentConfig, (input: ThreadTournamentInput) => {
    const parsed = toThreadTournamentCommand(input)
    if (parsed instanceof ArgsError) return Ref.set(rejectedRef, Option.some(parsed))
    return Ref.set(parsedRef, Option.some(parsed))
  }).pipe(
    CliCommand.withDescription("Run a read-only answer tournament across forked thread branches"),
    CliCommand.withShortDescription("Run tournament"),
  )

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

  const rebuildProjection = CliCommand.make("rebuild-projection", {}, () =>
    Ref.set(parsedRef, Option.some(toThreadRebuildProjectionCommand())),
  ).pipe(
    CliCommand.withDescription("Rebuild local thread projections from the event log"),
    CliCommand.withShortDescription("Rebuild thread projections"),
  )

  const importThreads = CliCommand.make("import", threadImportConfig, (input: ThreadImportInput) =>
    Ref.set(parsedRef, Option.some(toThreadImportCommand(input))),
  ).pipe(
    CliCommand.withDescription("Import threads from another Rika data directory"),
    CliCommand.withShortDescription("Import threads"),
  )

  return CliCommand.make("threads", {}, () =>
    Ref.set(rejectedRef, Option.some(new ArgsError({ message: "Expected a threads subcommand", exit_code: 2, usage }))),
  ).pipe(
    CliCommand.withDescription("Manage local Rika threads"),
    CliCommand.withShortDescription("Manage threads"),
    CliCommand.withSubcommands([
      list,
      search,
      archive,
      unarchive,
      compact,
      fork,
      visibility,
      tournament,
      share,
      reference,
      deleteThread,
      rebuildProjection,
      importThreads,
    ]),
  )
}

const makeProjectCommand = (
  parsedRef: Ref.Ref<Option.Option<Command>>,
  rejectedRef: Ref.Ref<Option.Option<ArgsError>>,
) => {
  const create = CliCommand.make("create", projectCreateConfig, (input: ProjectCreateInput) =>
    Ref.set(parsedRef, Option.some(toProjectCreateCommand(input))),
  ).pipe(CliCommand.withDescription("Create a project"), CliCommand.withShortDescription("Create project"))

  const list = CliCommand.make("list", {}, () => Ref.set(parsedRef, Option.some(toProjectListCommand()))).pipe(
    CliCommand.withDescription("List projects"),
    CliCommand.withShortDescription("List projects"),
  )

  const show = CliCommand.make("show", projectNameConfig, (input: ProjectNameInput) =>
    Ref.set(parsedRef, Option.some(toProjectNameCommand("show", input))),
  ).pipe(CliCommand.withDescription("Show a project"), CliCommand.withShortDescription("Show project"))

  const setEnv = CliCommand.make("set-env", projectSetEnvConfig, (input: ProjectSetEnvInput) =>
    Ref.set(parsedRef, Option.some(toProjectSetEnvCommand(input))),
  ).pipe(CliCommand.withDescription("Set a project environment variable"), CliCommand.withShortDescription("Set env"))

  const setSecret = CliCommand.make("set-secret", projectSetSecretConfig, (input: ProjectSetSecretInput) =>
    Ref.set(parsedRef, Option.some(toProjectSetSecretCommand(input))),
  ).pipe(CliCommand.withDescription("Set a project secret from stdin"), CliCommand.withShortDescription("Set secret"))

  return CliCommand.make("project", {}, () =>
    Ref.set(rejectedRef, Option.some(new ArgsError({ message: "Expected a project subcommand", exit_code: 2, usage }))),
  ).pipe(
    CliCommand.withDescription("Manage projects"),
    CliCommand.withShortDescription("Manage projects"),
    CliCommand.withSubcommands([create, list, show, setEnv, setSecret]),
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

  const add = CliCommand.make("add", skillAddConfig, (input: SkillAddInput) =>
    Ref.set(parsedRef, Option.some(toSkillAddCommand(input))),
  ).pipe(CliCommand.withDescription("Install a skill from a git source"), CliCommand.withShortDescription("Add skill"))

  const remove = CliCommand.make("remove", skillRemoveConfig, (input: SkillRemoveInput) =>
    Ref.set(parsedRef, Option.some(toSkillRemoveCommand(input))),
  ).pipe(CliCommand.withDescription("Remove an installed skill"), CliCommand.withShortDescription("Remove skill"))

  return CliCommand.make("skills", {}, () =>
    Ref.set(rejectedRef, Option.some(new ArgsError({ message: "Expected a skills subcommand", exit_code: 2, usage }))),
  ).pipe(
    CliCommand.withDescription("Manage installed Rika skills"),
    CliCommand.withShortDescription("Manage skills"),
    CliCommand.withSubcommands([list, inspect, add, remove]),
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
  const list = CliCommand.make("list", {}, () => Ref.set(parsedRef, Option.some(toConfigListCommand()))).pipe(
    CliCommand.withDescription("Print effective configuration with sources"),
    CliCommand.withShortDescription("List config"),
  )

  const keymap = CliCommand.make("keymap", {}, () => Ref.set(parsedRef, Option.some(toConfigKeymapCommand()))).pipe(
    CliCommand.withDescription("Print effective key bindings"),
    CliCommand.withShortDescription("Print keymap"),
  )

  const edit = CliCommand.make("edit", configEditConfig, (input: ConfigEditInput) =>
    Ref.set(parsedRef, Option.some(toConfigEditCommand(input))),
  ).pipe(CliCommand.withDescription("Open settings in EDITOR"), CliCommand.withShortDescription("Edit config"))

  return CliCommand.make("config", {}, () =>
    Ref.set(rejectedRef, Option.some(new ArgsError({ message: "Expected a config subcommand", exit_code: 2, usage }))),
  ).pipe(
    CliCommand.withDescription("Inspect Rika configuration"),
    CliCommand.withShortDescription("Inspect config"),
    CliCommand.withSubcommands([list, keymap, edit]),
  )
}

const makeOrbCommand = (parsedRef: Ref.Ref<Option.Option<Command>>, rejectedRef: Ref.Ref<Option.Option<ArgsError>>) => {
  const list = CliCommand.make("list", {}, () => Ref.set(parsedRef, Option.some(toOrbListCommand()))).pipe(
    CliCommand.withDescription("List local orbs"),
    CliCommand.withShortDescription("List orbs"),
  )

  const kill = CliCommand.make("kill", orbKillConfig, (input: OrbKillInput) =>
    Ref.set(parsedRef, Option.some(toOrbKillCommand(input))),
  ).pipe(CliCommand.withDescription("Kill an orb by thread id"), CliCommand.withShortDescription("Kill orb"))

  const shell = CliCommand.make("shell", orbShellConfig, (input: OrbShellInput) =>
    Ref.set(parsedRef, Option.some(toOrbShellCommand(input))),
  ).pipe(
    CliCommand.withDescription("Open a shell in an orb by thread id"),
    CliCommand.withShortDescription("Shell orb"),
  )

  const usageCommand = CliCommand.make("usage", orbUsageConfig, (input: OrbUsageInput) => {
    const parsed = toOrbUsageCommand(input)
    if (parsed instanceof ArgsError) return Ref.set(rejectedRef, Option.some(parsed))
    return Ref.set(parsedRef, Option.some(parsed))
  }).pipe(CliCommand.withDescription("Print orb running-minute usage"), CliCommand.withShortDescription("Orb usage"))

  const tournament = CliCommand.make("tournament", orbTournamentConfig, (input: OrbTournamentInput) => {
    const parsed = toOrbTournamentCommand(input)
    if (parsed instanceof ArgsError) return Ref.set(rejectedRef, Option.some(parsed))
    return Ref.set(parsedRef, Option.some(parsed))
  }).pipe(
    CliCommand.withDescription("Run a judged tournament across provisioned orbs"),
    CliCommand.withShortDescription("Run orb tournament"),
  )

  return CliCommand.make("orb", {}, () =>
    Ref.set(rejectedRef, Option.some(new ArgsError({ message: "Expected an orb subcommand", exit_code: 2, usage }))),
  ).pipe(
    CliCommand.withDescription("Manage local orbs"),
    CliCommand.withShortDescription("Manage orbs"),
    CliCommand.withSubcommands([list, kill, shell, usageCommand, tournament]),
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

const makeSyncCommand = (parsedRef: Ref.Ref<Option.Option<Command>>) =>
  CliCommand.make("sync", syncConfig, (input: SyncInput) => Ref.set(parsedRef, Option.some(toSyncCommand(input)))).pipe(
    CliCommand.withDescription("Mirror orb changes into a local worktree"),
    CliCommand.withShortDescription("Sync orb"),
  )

const makeMemoryCommand = (
  parsedRef: Ref.Ref<Option.Option<Command>>,
  rejectedRef: Ref.Ref<Option.Option<ArgsError>>,
) => {
  const index = CliCommand.make("index", memoryIndexConfig, (input: MemoryIndexInput) =>
    Ref.set(parsedRef, Option.some(toMemoryIndexCommand(input))),
  ).pipe(CliCommand.withDescription("Backfill thread memory chunks"), CliCommand.withShortDescription("Index memory"))

  const status = CliCommand.make("status", {}, () => Ref.set(parsedRef, Option.some(toMemoryStatusCommand()))).pipe(
    CliCommand.withDescription("Print thread memory status"),
    CliCommand.withShortDescription("Memory status"),
  )

  return CliCommand.make("memory", {}, () =>
    Ref.set(rejectedRef, Option.some(new ArgsError({ message: "Expected a memory subcommand", exit_code: 2, usage }))),
  ).pipe(
    CliCommand.withDescription("Inspect and backfill thread memory"),
    CliCommand.withShortDescription("Manage memory"),
    CliCommand.withSubcommands([index, status]),
  )
}

const makeDoctorCommand = (parsedRef: Ref.Ref<Option.Option<Command>>) =>
  CliCommand.make("doctor", {}, () => Ref.set(parsedRef, Option.some(toDoctorCommand()))).pipe(
    CliCommand.withDescription("Print local diagnostics without uploading telemetry"),
    CliCommand.withShortDescription("Print diagnostics"),
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
  const projectName = Option.getOrUndefined(input.project)
  const workspaceRoot = Option.getOrUndefined(input.workspace)
  const threadId = Option.getOrUndefined(input.thread)
  return {
    type: "execute",
    prompt: input.prompt.join(" ").trim(),
    orb: input.orb,
    stream_json: input.streamJson,
    stream_json_input: input.streamJsonInput,
    ephemeral: input.ephemeral,
    ...(mode === undefined ? {} : { mode }),
    ...(projectName === undefined ? {} : { project_name: projectName }),
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
    orb: input.orb,
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
    ...(input.semantic ? { semantic: true } : {}),
    ...(input.includeArchived ? { include_archived: true } : {}),
    ...(limit === undefined ? {} : { limit }),
  }
}

const toThreadIdCommand = (
  action: Extract<ThreadAction, "archive" | "unarchive" | "compact" | "share" | "delete">,
  input: ThreadIdInput,
): ThreadCommand => ({
  type: "threads",
  action,
  thread_id: Ids.ThreadId.make(input.threadId),
})

const toThreadForkCommand = (input: ThreadForkInput): ThreadCommand => {
  const atTurn = Option.getOrUndefined(input.atTurn)
  return {
    type: "threads",
    action: "fork",
    thread_id: Ids.ThreadId.make(input.threadId),
    ...(atTurn === undefined ? {} : { at_turn: Ids.TurnId.make(atTurn) }),
  }
}

const toThreadVisibilityCommand = (input: ThreadVisibilityInput): ThreadCommand | ArgsError => {
  const visibility = parseThreadVisibility(input.visibility)
  if (visibility === undefined) {
    return new ArgsError({ message: `Invalid thread visibility: ${input.visibility}`, exit_code: 2, usage })
  }
  return {
    type: "threads",
    action: "visibility",
    thread_id: Ids.ThreadId.make(input.threadId),
    visibility,
  }
}

const toThreadTournamentCommand = (input: ThreadTournamentInput): ThreadCommand | ArgsError => {
  const modes = parseModeList(Option.getOrUndefined(input.modes))
  if (modes instanceof ArgsError) return modes
  const rubric = Option.getOrUndefined(input.rubric)
  return {
    type: "threads",
    action: "tournament",
    thread_id: Ids.ThreadId.make(input.threadId),
    message: input.message,
    branch_count: input.branchCount,
    ...(modes === undefined ? {} : { modes }),
    ...(rubric === undefined ? {} : { rubric }),
  }
}

const toThreadReferenceCommand = (input: ThreadReferenceInput): ThreadCommand => {
  const query = input.query.join(" ").trim()
  return {
    type: "threads",
    action: "reference",
    thread_id: Ids.ThreadId.make(input.threadId),
    ...(query.length === 0 ? {} : { query }),
  }
}

const toThreadRebuildProjectionCommand = (): ThreadCommand => ({
  type: "threads",
  action: "rebuild-projection",
})

const toThreadImportCommand = (input: ThreadImportInput): ThreadCommand => ({
  type: "threads",
  action: "import",
  source_data_dir: input.source,
})

const parseModeList = (value: string | undefined): ReadonlyArray<Config.Mode> | undefined | ArgsError => {
  if (value === undefined) return undefined
  const modes: Array<Config.Mode> = []
  for (const part of value.split(",")) {
    const mode = parseMode(part.trim())
    if (mode === undefined) {
      return new ArgsError({ message: `Invalid tournament mode: ${part.trim()}`, exit_code: 2, usage })
    }
    modes.push(mode)
  }
  return modes
}

const parseMode = (value: string): Config.Mode | undefined =>
  value === "rush" || value === "smart" || value === "deep1" || value === "deep2" || value === "deep3"
    ? value
    : undefined

const parseThreadVisibility = (value: string) =>
  value === "private" || value === "workspace" || value === "unlisted" ? value : undefined

const toProjectCreateCommand = (input: ProjectCreateInput): ProjectCommand => {
  const repoOrigin = Option.getOrUndefined(input.repo)
  const defaultBranch = Option.getOrUndefined(input.branch)
  const templateId = Option.getOrUndefined(input.template)
  return {
    type: "project",
    action: "create",
    name: input.name,
    ...(repoOrigin === undefined ? {} : { repo_origin: repoOrigin }),
    ...(defaultBranch === undefined ? {} : { default_branch: defaultBranch }),
    ...(templateId === undefined ? {} : { template_id: templateId }),
  }
}

const toProjectListCommand = (): ProjectCommand => ({ type: "project", action: "list" })

const toProjectNameCommand = (action: Extract<ProjectAction, "show">, input: ProjectNameInput): ProjectCommand => ({
  type: "project",
  action,
  name: input.name,
})

const toProjectSetEnvCommand = (input: ProjectSetEnvInput): ProjectCommand => ({
  type: "project",
  action: "set-env",
  name: input.name,
  env_assignment: input.assignment,
})

const toProjectSetSecretCommand = (input: ProjectSetSecretInput): ProjectCommand => ({
  type: "project",
  action: "set-secret",
  name: input.name,
  secret_name: input.key,
})

const toSkillListCommand = (): SkillCommand => ({ type: "skills", action: "list" })

const toSkillInspectCommand = (input: SkillNameInput): SkillCommand => ({
  type: "skills",
  action: "inspect",
  name: input.name,
})

const toSkillAddCommand = (input: SkillAddInput): SkillCommand => ({
  type: "skills",
  action: "add",
  source: input.source,
  user: input.user,
  force: input.force,
})

const toSkillRemoveCommand = (input: SkillRemoveInput): SkillCommand => ({
  type: "skills",
  action: "remove",
  name: input.name,
  user: input.user,
})

const toMcpListCommand = (): McpCommand => ({ type: "mcp", action: "list" })

const toMcpApproveCommand = (input: McpServerInput): McpCommand => ({
  type: "mcp",
  action: "approve",
  server_name: input.serverName,
})

const toMcpDoctorCommand = (): McpCommand => ({ type: "mcp", action: "doctor" })

const toConfigKeymapCommand = (): ConfigCommand => ({ type: "config", action: "keymap" })

const toConfigListCommand = (): ConfigCommand => ({ type: "config", action: "list" })

const toConfigEditCommand = (input: ConfigEditInput): ConfigCommand => ({
  type: "config",
  action: "edit",
  ...(input.workspace ? { workspace: true } : {}),
})

const toVersionCommandValue = (): VersionCommand => ({ type: "version" })

const toVersionCommand = (argv: ReadonlyArray<string>): VersionCommand | undefined =>
  argv.length === 1 && (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "-V" || argv[0] === "version")
    ? toVersionCommandValue()
    : undefined

const toMcpCommand = (argv: ReadonlyArray<string>): McpCommand | ArgsError | undefined => {
  if (argv[0] !== "mcp") return undefined
  const action = argv[1]
  if (action === "doctor") {
    return argv.length === 2 ? toMcpDoctorCommand() : mcpArgsError("rika mcp doctor does not accept arguments")
  }
  if (action === "remove") return parseMcpRemove(argv.slice(2))
  if (action === "add") return parseMcpAdd(argv.slice(2))
  return undefined
}

const parseMcpAdd = (argv: ReadonlyArray<string>): McpCommand | ArgsError => {
  const separator = argv.indexOf("--")
  const head = separator < 0 ? argv : argv.slice(0, separator)
  const command = separator < 0 ? [] : argv.slice(separator + 1)
  const parsed = parseMcpNameOptions(head)
  if (parsed instanceof ArgsError) return parsed
  if (parsed.name === undefined) return mcpArgsError("rika mcp add requires a server name")
  if (parsed.url !== undefined && command.length > 0) {
    return mcpArgsError("rika mcp add accepts either --url or command argv, not both")
  }
  if (parsed.url === undefined && command.length === 0) {
    return mcpArgsError("rika mcp add requires --url or command argv after --")
  }
  return {
    type: "mcp",
    action: "add",
    server_name: parsed.name,
    ...(parsed.global ? { global: true } : {}),
    ...(parsed.url === undefined ? { command: command[0] ?? "", args: command.slice(1) } : { url: parsed.url }),
  }
}

const parseMcpRemove = (argv: ReadonlyArray<string>): McpCommand | ArgsError => {
  const parsed = parseMcpNameOptions(argv)
  if (parsed instanceof ArgsError) return parsed
  if (parsed.url !== undefined) return mcpArgsError("rika mcp remove does not accept --url")
  if (parsed.name === undefined) return mcpArgsError("rika mcp remove requires a server name")
  return {
    type: "mcp",
    action: "remove",
    server_name: parsed.name,
    ...(parsed.global ? { global: true } : {}),
  }
}

interface ParsedMcpNameOptions {
  readonly name?: string
  readonly url?: string
  readonly global: boolean
}

const parseMcpNameOptions = (argv: ReadonlyArray<string>): ParsedMcpNameOptions | ArgsError => {
  let name: string | undefined
  let url: string | undefined
  let global = false
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === "--global") {
      global = true
      continue
    }
    if (token === "--url") {
      const value = argv[index + 1]
      if (value === undefined || value.length === 0) return mcpArgsError("rika mcp add --url requires a value")
      url = value
      index += 1
      continue
    }
    if (token?.startsWith("--") === true) return mcpArgsError(`Unknown rika mcp option ${token}`)
    if (name !== undefined) return mcpArgsError(`Unexpected rika mcp argument ${token}`)
    name = token
  }
  return { global, ...(name === undefined ? {} : { name }), ...(url === undefined ? {} : { url }) }
}

const mcpArgsError = (message: string) => new ArgsError({ message, exit_code: 2, usage })

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
                    argv[1] === "fork" &&
                    (argv[2] === "--help" || argv[2] === "-h")
                  ? { type: "help", topic: "threads-fork" }
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
                                : argv.length === 2 &&
                                    argv[0] === "logout" &&
                                    (argv[1] === "--help" || argv[1] === "-h")
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
  const baseCommit = Option.getOrUndefined(input.baseCommit)
  return {
    type: "server",
    orb: input.orb,
    ephemeral: input.ephemeral,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(token === undefined ? {} : { token }),
    ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot }),
    ...(baseCommit === undefined ? {} : { base_commit: baseCommit }),
  }
}

const toSyncCommand = (input: SyncInput): SyncCommand => ({
  type: "sync",
  thread_id: Ids.ThreadId.make(input.threadId),
})

const toMemoryIndexCommand = (input: MemoryIndexInput): MemoryCommand => {
  const workspaceRoot = Option.getOrUndefined(input.workspace)
  return {
    type: "memory",
    action: "index",
    ...(workspaceRoot === undefined ? {} : { workspace_root: workspaceRoot }),
  }
}

const toMemoryStatusCommand = (): MemoryCommand => ({
  type: "memory",
  action: "status",
})

const toOrbListCommand = (): OrbCommand => ({
  type: "orb",
  action: "list",
})

const toOrbKillCommand = (input: OrbKillInput): OrbCommand => ({
  type: "orb",
  action: "kill",
  thread_id: Ids.ThreadId.make(input.threadId),
  force: input.force,
})

const toOrbShellCommand = (input: OrbShellInput): OrbCommand => ({
  type: "orb",
  action: "shell",
  thread_id: Ids.ThreadId.make(input.threadId),
})

const toOrbUsageCommand = (input: OrbUsageInput): OrbCommand | ArgsError => {
  const projectName = Option.getOrUndefined(input.project)
  const sinceText = Option.getOrUndefined(input.since)
  const since = sinceText === undefined ? undefined : Date.parse(sinceText)
  if (sinceText !== undefined && Number.isNaN(since)) {
    return new ArgsError({ message: `Invalid --since date: ${sinceText}`, exit_code: 2, usage })
  }
  return {
    type: "orb",
    action: "usage",
    ...(projectName === undefined ? {} : { project_name: projectName }),
    ...(since === undefined ? {} : { since: Common.TimestampMillis.make(since) }),
  }
}

const toOrbTournamentCommand = (input: OrbTournamentInput): OrbCommand | ArgsError => {
  const modes = parseModeList(Option.getOrUndefined(input.modes))
  if (modes instanceof ArgsError) return modes
  const projectName = Option.getOrUndefined(input.project)
  const rubric = Option.getOrUndefined(input.rubric)
  return {
    type: "orb",
    action: "tournament",
    task: input.task,
    branch_count: input.branchCount,
    ...(projectName === undefined ? {} : { project_name: projectName }),
    ...(modes === undefined ? {} : { modes }),
    ...(rubric === undefined ? {} : { rubric }),
    sync_winner: input.syncWinner,
    keep_losers: input.keepLosers,
    yes: input.yes,
  }
}

const toDoctorCommand = (): DoctorCommand => ({ type: "doctor" })

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
