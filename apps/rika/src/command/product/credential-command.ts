import * as ProductOperation from "@rika/product/product-operation"
import { Console, Effect, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Writable } from "node:stream"
import { createInterface } from "node:readline"
import { dispatch } from "../root/cli-operation-dispatch"

const provider = Argument.choice("provider", ["openai", "openrouter"])
const scope = Flag.choice("scope", ["local", "user", "organization"]).pipe(Flag.withDefault("local"))

const requireLocal = (selected: "local" | "user" | "organization") =>
  selected === "local"
    ? Effect.void
    : Effect.fail(
        ProductOperation.OperationUnavailable.make({
          operation: "Credential",
          message: `${selected} provider credential storage belongs to the hosted control plane and is not available locally`,
        }),
      )

const readSecret = Effect.callback<Option.Option<string>>((resume) => {
  process.stderr.write("Paste your OpenRouter API key: ")
  const output = new Writable({ write: (_chunk, _encoding, callback) => callback() })
  const readline = createInterface({ input: process.stdin, output, terminal: true })
  readline.question("", (answer) => {
    readline.close()
    process.stderr.write("\n")
    const value = answer.trim()
    resume(Effect.succeed(value.length === 0 ? Option.none() : Option.some(value)))
  })
})

const set = Command.make(
  "set",
  { provider, scope, deviceCode: Flag.boolean("device-code") },
  ({ provider: selectedProvider, scope: selectedScope, deviceCode }) =>
    requireLocal(selectedScope).pipe(
      Effect.andThen(
        selectedProvider === "openrouter"
          ? Effect.flatMap(readSecret, (apiKey) =>
              Option.match(apiKey, {
                onNone: () => Console.error("An OpenRouter API key is required"),
                onSome: (value) =>
                  dispatch({ _tag: "Auth", action: "login", provider: selectedProvider, apiKey: value }),
              }),
            )
          : dispatch({ _tag: "Auth", action: "login", provider: selectedProvider, deviceCode }),
      ),
    ),
)

const list = Command.make(
  "list",
  { provider: provider.pipe(Argument.optional), scope },
  ({ provider: selectedProvider, scope: selectedScope }) =>
    requireLocal(selectedScope).pipe(
      Effect.andThen(
        Option.match(selectedProvider, {
          onNone: () =>
            Effect.all(
              [
                dispatch({ _tag: "Auth", action: "status", provider: "openai" }),
                dispatch({ _tag: "Auth", action: "status", provider: "openrouter" }),
              ],
              { concurrency: 1, discard: true },
            ),
          onSome: (value) => dispatch({ _tag: "Auth", action: "status", provider: value }),
        }),
      ),
    ),
)

const rotate = Command.make(
  "rotate",
  { provider, scope, deviceCode: Flag.boolean("device-code") },
  ({ provider: selectedProvider, scope: selectedScope, deviceCode }) =>
    requireLocal(selectedScope).pipe(
      Effect.andThen(
        selectedProvider === "openrouter"
          ? Effect.flatMap(readSecret, (apiKey) =>
              Option.match(apiKey, {
                onNone: () => Console.error("An OpenRouter API key is required"),
                onSome: (value) =>
                  dispatch({ _tag: "Auth", action: "login", provider: selectedProvider, apiKey: value }),
              }),
            )
          : dispatch({ _tag: "Auth", action: "login", provider: selectedProvider, deviceCode }),
      ),
    ),
)

const revoke = Command.make("revoke", { provider, scope }, ({ provider: selectedProvider, scope: selectedScope }) =>
  requireLocal(selectedScope).pipe(
    Effect.andThen(dispatch({ _tag: "Auth", action: "logout", provider: selectedProvider })),
  ),
)

export const credentialCommand = Command.make("credential").pipe(
  Command.withDescription("Manage model-provider credentials by scope"),
  Command.withSubcommands([set, list, rotate, revoke]),
)
