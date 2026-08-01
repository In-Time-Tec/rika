import { Argument, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "../root/cli-operation-dispatch"

const providerArgument = Argument.choice("provider", ["openai"])

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage model provider account authentication"),
  Command.withSubcommands([
    Command.make(
      "login",
      { provider: providerArgument, deviceCode: Flag.boolean("device-code") },
      ({ provider, deviceCode }) => dispatch({ _tag: "Auth", action: "login", provider, deviceCode }),
    ),
    Command.make("status", { provider: providerArgument }, ({ provider }) =>
      dispatch({ _tag: "Auth", action: "status", provider }),
    ),
    Command.make("logout", { provider: providerArgument }, ({ provider }) =>
      dispatch({ _tag: "Auth", action: "logout", provider }),
    ),
  ]),
)
