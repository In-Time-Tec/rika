import * as Operation from "@rika/app/operation"
import { Effect, Option, Schema } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "./shared"

const nameArgument = Argument.string("name")
const oauth = Command.make("oauth").pipe(
  Command.withSubcommands([
    Command.make("login", { name: nameArgument }, ({ name }) => dispatch({ _tag: "Mcp", action: "oauth-login", name })),
    Command.make("logout", { name: nameArgument }, ({ name }) =>
      dispatch({ _tag: "Mcp", action: "oauth-logout", name }),
    ),
    Command.make("status", { name: nameArgument.pipe(Argument.optional) }, ({ name }) => {
      const selectedName = Option.getOrUndefined(name)
      return dispatch({
        _tag: "Mcp",
        action: "oauth-status",
        ...(selectedName === undefined ? {} : { name: selectedName }),
      })
    }),
  ]),
)

const add = Command.make(
  "add",
  {
    name: nameArgument,
    url: Flag.string("url").pipe(Flag.optional),
    command: Argument.variadic(Argument.string("command")),
  },
  ({ name, url, command }) =>
    Effect.gen(function* () {
      const selectedUrl = Option.getOrUndefined(url)
      if ((selectedUrl === undefined) === (command.length === 0)) {
        return yield* Operation.InvalidInput.make({ message: "mcp add requires exactly one of --url or a command" })
      }
      const [firstCommand, ...commandArgs] = command
      if (selectedUrl !== undefined) {
        yield* dispatch({ _tag: "Mcp", action: "add", name, url: selectedUrl })
        return
      }
      const decodedCommand = yield* Schema.decodeUnknownEffect(Schema.NonEmptyArray(Schema.String))([
        firstCommand,
        ...commandArgs,
      ]).pipe(Effect.mapError(() => Operation.InvalidInput.make({ message: "mcp add requires a command" })))
      yield* dispatch({
        _tag: "Mcp",
        action: "add",
        name,
        command: decodedCommand,
      })
    }),
)

export const command = Command.make("mcp").pipe(
  Command.withDescription("Manage Model Context Protocol servers"),
  Command.withSubcommands([
    Command.make("list", {}, () => dispatch({ _tag: "Mcp", action: "list" })),
    add,
    Command.make("remove", { name: nameArgument }, ({ name }) => dispatch({ _tag: "Mcp", action: "remove", name })),
    Command.make("enable", { name: nameArgument }, ({ name }) => dispatch({ _tag: "Mcp", action: "enable", name })),
    Command.make("disable", { name: nameArgument }, ({ name }) => dispatch({ _tag: "Mcp", action: "disable", name })),
    Command.make(
      "approve",
      { name: nameArgument, workspace: Flag.directory("workspace").pipe(Flag.optional) },
      ({ name, workspace }) => {
        const selectedWorkspace = Option.getOrUndefined(workspace)
        return dispatch({
          _tag: "Mcp",
          action: "approve",
          name,
          ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
        })
      },
    ),
    Command.make("doctor", {}, () => dispatch({ _tag: "Mcp", action: "doctor" })),
    oauth,
  ]),
)
