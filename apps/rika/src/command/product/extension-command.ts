import { Argument, Command } from "effect/unstable/cli"
import { dispatch } from "../root/cli-operation-dispatch"

const nameArgument = Argument.string("name")

export const extensionCommand = Command.make("extensions").pipe(
  Command.withDescription("Manage trusted local extensions"),
  Command.withSubcommands([
    Command.make("list", {}, () => dispatch({ _tag: "Extension", action: "list" })),
    Command.make("create-skill", { name: nameArgument }, ({ name }) =>
      dispatch({ _tag: "Extension", action: "create-skill", name }),
    ),
    Command.make("create-plugin", { name: nameArgument }, ({ name }) =>
      dispatch({ _tag: "Extension", action: "create-plugin", name }),
    ),
    Command.make("enable", { name: nameArgument }, ({ name }) =>
      dispatch({ _tag: "Extension", action: "enable", name }),
    ),
    Command.make("disable", { name: nameArgument }, ({ name }) =>
      dispatch({ _tag: "Extension", action: "disable", name }),
    ),
    Command.make("rollback", { name: nameArgument }, ({ name }) =>
      dispatch({ _tag: "Extension", action: "rollback", name }),
    ),
  ]),
)
