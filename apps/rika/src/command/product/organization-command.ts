import { Argument, Command } from "effect/unstable/cli"
import { dispatch } from "../root/hosted-command-dispatch"

export const organizationCommand = Command.make("org").pipe(
  Command.withDescription("Manage hosted Rika organizations"),
  Command.withSubcommands([
    Command.make("list", {}, () => dispatch({ _tag: "Organization", action: "list" })),
    Command.make("personal", {}, () => dispatch({ _tag: "Organization", action: "personal" })),
    Command.make("use", { organization: Argument.string("organization") }, ({ organization }) =>
      dispatch({ _tag: "Organization", action: "use", organization }),
    ),
    Command.make("invite", { email: Argument.string("email") }, ({ email }) =>
      dispatch({ _tag: "Organization", action: "invite", email }),
    ),
  ]),
)
