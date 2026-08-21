import { Console, Effect, Option } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import { Writable } from "node:stream"
import { createInterface } from "node:readline"
import { dispatch } from "../root/hosted-command-dispatch"

const providerArgument = Argument.choice("provider", ["openai", "anthropic", "openrouter"])

const readSecret = (selectedProvider: "openai" | "anthropic" | "openrouter") =>
  Effect.callback<Option.Option<string>>((resume) => {
    process.stderr.write(`Paste your ${selectedProvider} API key: `)
    const output = new Writable({ write: (_chunk, _encoding, callback) => callback() })
    const readline = createInterface({ input: process.stdin, output, terminal: true })
    readline.question("", (answer) => {
      readline.close()
      process.stderr.write("\n")
      const value = answer.trim()
      resume(Effect.succeed(value.length === 0 ? Option.none() : Option.some(value)))
    })
  })

const put = (action: "set" | "rotate") =>
  Command.make(action, { provider: providerArgument }, ({ provider: selectedProvider }) =>
    Effect.flatMap(readSecret(selectedProvider), (apiKey) =>
      Option.match(apiKey, {
        onNone: () => Console.error("An API key is required"),
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
