import { Argument, Command, Flag } from "effect/unstable/cli"
import { Option } from "effect"
import { dispatch } from "../root/cli-operation-dispatch"

export const toolCatalogCommand = Command.make("tools").pipe(
  Command.withDescription("Inspect the static built-in tool catalog"),
  Command.withSubcommands([
    Command.make("list", { mode: Flag.string("mode").pipe(Flag.optional) }, ({ mode }) => {
      const selectedMode = Option.getOrUndefined(mode)
      return dispatch({
        _tag: "ToolCatalog",
        action: "list",
        ...(selectedMode === undefined ? {} : { mode: selectedMode }),
      })
    }),
    Command.make("show", { name: Argument.string("name") }, ({ name }) =>
      dispatch({ _tag: "ToolCatalog", action: "show", name }),
    ),
  ]),
)
