import { Effect, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "../root/hosted-command-dispatch"
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
      onSome: (secret) =>
        dispatch({
          _tag: "Secret",
          action: "put",
          name,
          value: secret,
          ...(Option.isSome(scope) ? { scope: scope.value } : {}),
          ...(Option.isSome(phase) ? { phase: phase.value } : {}),
        }),
    }),
  ),
)

const revoke = Command.make("revoke", { name: nameArgument, scope: scopeFlag }, ({ name, scope }) =>
  dispatch({
    _tag: "Secret",
    action: "revoke",
    name,
    ...(Option.isSome(scope) ? { scope: scope.value } : {}),
  }),
)

export const secretCommand = Command.make("secret").pipe(
  Command.withDescription("Manage encrypted personal, Organization, and Project environment secrets"),
  Command.withSubcommands([set, revoke]),
)
