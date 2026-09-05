import { Effect, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "../root/cli-operation"

export const doctorCommand = Command.make("doctor", {}, () => dispatch({ _tag: "Doctor" })).pipe(
  Command.withDescription("Report local settings, model route, and credential presence; no server health check"),
)

export const configCommand = Command.make("config").pipe(
  Command.withDescription("Inspect local configuration or open settings in VISUAL/EDITOR"),
  Command.withSubcommands([
    Command.make("list", {}, () => dispatch({ _tag: "Config", action: "list" })),
    Command.make("keymap", {}, () => dispatch({ _tag: "Config", action: "keymap" })),
    Command.make("edit", { workspace: Flag.boolean("workspace").pipe(Flag.withDefault(false)) }, ({ workspace }) =>
      dispatch({ _tag: "Config", action: "edit", workspace }),
    ),
  ]),
)

export const toolsCommand = Command.make("tools").pipe(
  Command.withDescription("Inspect the four native tool definitions (not MCP tools)"),
  Command.withSubcommands([
    Command.make("list", {}, () => dispatch({ _tag: "ToolCatalog", action: "list" })),
    Command.make("show", { name: Argument.string("name") }, ({ name }) =>
      dispatch({ _tag: "ToolCatalog", action: "show", name }),
    ),
  ]),
)

export const skillsCommand = Command.make("skills").pipe(
  Command.withDescription("Discover skills; add a local directory to or remove a skill from this Workspace"),
  Command.withSubcommands([
    Command.make("list", {}, () => dispatch({ _tag: "Skill", action: "list" })),
    Command.make("add", { source: Argument.string("directory") }, ({ source }) =>
      dispatch({ _tag: "Skill", action: "add", source }),
    ),
    ...(["inspect", "remove"] as const).map((action) =>
      Command.make(action, { name: Argument.string("name") }, ({ name }) => dispatch({ _tag: "Skill", action, name })),
    ),
  ]),
)

export const extensionsCommand = Command.make("extensions").pipe(
  Command.withDescription("Manage Workspace extension lifecycle records; does not install plugins"),
  Command.withSubcommands([
    Command.make("list", {}, () => dispatch({ _tag: "Extension", action: "list" })),
    ...(["enable", "disable", "rollback"] as const).map((action) =>
      Command.make(action, { name: Argument.string("name") }, ({ name }) =>
        dispatch({ _tag: "Extension", action, name }),
      ),
    ),
  ]),
)

export const mcpCommand = Command.make("mcp").pipe(
  Command.withDescription("Manage Workspace MCP configuration and OAuth; does not mount model tools"),
  Command.withSubcommands([
    Command.make("list", {}, () => dispatch({ _tag: "Mcp", action: "list" })),
    Command.make("doctor", {}, () => dispatch({ _tag: "Mcp", action: "doctor" })).pipe(
      Command.withDescription("Validate and list configuration without connecting to servers"),
    ),
    Command.make(
      "add",
      {
        name: Argument.string("name"),
        url: Flag.string("url").pipe(Flag.optional),
        command: Argument.variadic(Argument.string("command")),
      },
      ({ name, url, command }) => {
        if (Option.isSome(url) && command.length === 0)
          return dispatch({ _tag: "Mcp", action: "add", name, url: url.value })
        const [executable, ...args] = command
        if (Option.isNone(url) && executable !== undefined)
          return dispatch({ _tag: "Mcp", action: "add", name, command: [executable, ...args] })
        return Effect.fail(
          CliError.UserError.make({
            cause: "Invalid MCP transport",
            userMessage: "Supply either --url <url> or -- <command> [args...], not both",
          }),
        )
      },
    ),
    ...(["remove", "enable", "disable", "oauth-login", "oauth-logout"] as const).map((action) =>
      Command.make(action, { name: Argument.string("name") }, ({ name }) => dispatch({ _tag: "Mcp", action, name })),
    ),
    Command.make("oauth-status", { name: Argument.string("name").pipe(Argument.optional) }, ({ name }) =>
      dispatch(
        Option.isSome(name)
          ? { _tag: "Mcp", action: "oauth-status", name: name.value }
          : { _tag: "Mcp", action: "oauth-status" },
      ),
    ),
  ]),
)
