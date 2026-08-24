import * as ProductOperation from "@rika/product/product-operation"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "../root/cli-operation"

const authInput = (action: "login" | "status" | "logout", deviceCode = false): ProductOperation.Input => ({
  _tag: "Auth",
  action,
  provider: "openai",
  ...(action === "login" && deviceCode ? { deviceCode: true } : {}),
})

const codex = Argument.choice("provider", ["codex"])

const login = Command.make(
  "login",
  {
    provider: codex,
    deviceCode: Flag.boolean("device-code").pipe(Flag.withDefault(false)),
  },
  ({ deviceCode }) => dispatch(authInput("login", deviceCode)),
).pipe(Command.withDescription("Log in to Codex with an OpenAI account"))

const status = Command.make("status", { provider: codex }, () => dispatch(authInput("status"))).pipe(
  Command.withDescription("Show model-provider authentication status"),
)

const logout = Command.make("logout", { provider: codex }, () => dispatch(authInput("logout"))).pipe(
  Command.withDescription("Remove local model-provider credentials"),
)

export const providerCommand = Command.make("provider").pipe(
  Command.withDescription("Manage local model-provider authentication"),
  Command.withSubcommands([login, status, logout]),
)
