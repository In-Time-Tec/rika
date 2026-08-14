import { Argument, Command, Flag } from "effect/unstable/cli"
import { Console, Effect, Option } from "effect"
import { createInterface } from "node:readline"
import { dispatch } from "../root/cli-operation-dispatch"

const providerArgument = Argument.choice("provider", ["openai", "openrouter"])

const readApiKey = Effect.callback<Option.Option<string>>((resume) => {
  const readline = createInterface({ input: process.stdin, output: process.stderr })
  readline.question("Paste your OpenRouter API key: ", (answer) => {
    readline.close()
    const apiKey = answer.trim()
    resume(Effect.succeed(apiKey.length === 0 ? Option.none() : Option.some(apiKey)))
  })
})

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage model provider account authentication"),
  Command.withSubcommands([
    Command.make(
      "login",
      { provider: providerArgument, deviceCode: Flag.boolean("device-code") },
      ({ provider, deviceCode }) =>
        provider === "openrouter"
          ? Effect.flatMap(readApiKey, (apiKey) =>
              Option.match(apiKey, {
                onNone: () => Console.error("An OpenRouter API key is required"),
                onSome: (value) => dispatch({ _tag: "Auth", action: "login", provider, apiKey: value }),
              }),
            )
          : dispatch({ _tag: "Auth", action: "login", provider, deviceCode }),
    ),
    Command.make("status", { provider: providerArgument }, ({ provider }) =>
      dispatch({ _tag: "Auth", action: "status", provider }),
    ),
    Command.make("logout", { provider: providerArgument }, ({ provider }) =>
      dispatch({ _tag: "Auth", action: "logout", provider }),
    ),
  ]),
)
