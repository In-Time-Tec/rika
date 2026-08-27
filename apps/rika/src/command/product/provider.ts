import { Argument, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "../root/hosted"

const codex = Argument.choice("provider", ["codex"])

const login = Command.make(
  "login",
  {
    provider: codex,
    deviceCode: Flag.boolean("device-code").pipe(Flag.withDefault(false)),
  },
  ({ deviceCode }) => dispatch({ _tag: "Provider", action: "login", deviceCode }),
).pipe(Command.withDescription("Log in to Codex with an OpenAI account"))

const status = Command.make("status", { provider: codex }, () => dispatch({ _tag: "Provider", action: "status" })).pipe(
  Command.withDescription("Show model-provider authentication status"),
)

const logout = Command.make("logout", { provider: codex }, () => dispatch({ _tag: "Provider", action: "logout" })).pipe(
  Command.withDescription("Remove model-provider credentials"),
)

export const providerCommand = Command.make("provider").pipe(
  Command.withDescription("Manage model-provider authentication"),
  Command.withSubcommands([login, status, logout]),
)
