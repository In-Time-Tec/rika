import { Effect, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "../root/hosted"
import { readSecret } from "./read-secret"

const scopeFlag = Flag.choice("scope", ["personal", "organization", "project"]).pipe(Flag.optional)
const phaseFlag = Flag.choice("phase", ["setup", "runtime"]).pipe(Flag.optional)
const nameArgument = Argument.string("name")

const set = Command.make("set", { name: nameArgument, scope: scopeFlag, phase: phaseFlag }, ({ name, scope, phase }) =>
  Effect.flatMap(readSecret(`Paste ${name}: `), (value) =>
    Option.match(value, {
      onNone: () =>
        Effect.fail(
          CliError.UserError.make({ cause: "Missing secret value", userMessage: "A secret value is required" }),
        ),
      onSome: (secret) => {
        const input: Parameters<typeof dispatch>[0] = {
          _tag: "Secret",
          action: "put",
          name,
          value: secret,
        }
        if (Option.isSome(scope)) Object.assign(input, { scope: scope.value })
        if (Option.isSome(phase)) Object.assign(input, { phase: phase.value })
        return dispatch(input)
      },
    }),
  ),
)

const revoke = Command.make("revoke", { name: nameArgument, scope: scopeFlag }, ({ name, scope }) =>
  Option.match(scope, {
    onNone: () => dispatch({ _tag: "Secret", action: "revoke", name }),
    onSome: (selectedScope) => dispatch({
    _tag: "Secret",
    action: "revoke",
    name,
    scope: selectedScope,
    }),
  }),
)

export const secretCommand = Command.make("secret").pipe(
  Command.withDescription("Manage encrypted personal, Organization, and Project environment secrets"),
  Command.withSubcommands([set, revoke]),
)
