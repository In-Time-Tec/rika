import { Command, Flag } from "effect/unstable/cli"
import { dispatch } from "../root/cli-operation-dispatch"

export const configurationCommand = Command.make("config").pipe(
  Command.withDescription("Inspect and edit Rika configuration"),
  Command.withSubcommands([
    Command.make("list", {}, () => dispatch({ _tag: "Config", action: "list" })),
    Command.make("edit", { workspace: Flag.boolean("workspace") }, ({ workspace }) =>
      dispatch({ _tag: "Config", action: "edit", workspace }),
    ),
    Command.make("keymap", {}, () => dispatch({ _tag: "Config", action: "keymap" })),
  ]),
)
