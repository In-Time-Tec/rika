import { Effect, Option } from "effect"
import { Argument, CliError, Command } from "effect/unstable/cli"
import { dispatch } from "../root/hosted"
import { readSecret } from "./read-secret"

const providerArgument = Argument.choice("provider", ["openai", "anthropic", "openrouter"])

const put = (action: "set" | "rotate") =>
  Command.make(action, { provider: providerArgument }, ({ provider: selectedProvider }) =>
    Effect.flatMap(readSecret(`Paste your ${selectedProvider} API key: `), (apiKey) =>
      Option.match(apiKey, {
        onNone: () =>
          Effect.fail(CliError.UserError.make({ cause: "Missing API key", userMessage: "An API key is required" })),
        onSome: (value) => dispatch({ _tag: "Credential", action: "put", provider: selectedProvider, apiKey: value }),
      }),
    ),
  )

const list = Command.make("list", { provider: providerArgument.pipe(Argument.optional) }, ({ provider: selected }) =>
  dispatch({ _tag: "Credential", action: "list", ...(Option.isSome(selected) ? { provider: selected.value } : {}) }),
)

const revoke = Command.make("revoke", { provider: providerArgument }, ({ provider: selected }) =>
  dispatch({ _tag: "Credential", action: "revoke", provider: selected }),
)

export const credentialCommand = Command.make("credential").pipe(
  Command.withDescription("Manage hosted model-provider credentials for the selected owner"),
  Command.withSubcommands([put("set"), list, put("rotate"), revoke]),
)
