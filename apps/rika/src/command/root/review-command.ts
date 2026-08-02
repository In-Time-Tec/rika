import { Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "./cli-operation-dispatch"

const optionalValue = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value)

export const reviewCommand = Command.make(
  "review",
  {
    staged: Flag.boolean("staged"),
    base: Flag.string("base").pipe(Flag.optional),
    workspace: Flag.directory("workspace").pipe(Flag.optional),
    ephemeral: Flag.boolean("ephemeral"),
    json: Flag.boolean("json"),
    paths: Argument.variadic(Argument.string("path")),
  },
  (values) => {
    const selectedBase = optionalValue(values.base)
    const selectedWorkspace = optionalValue(values.workspace)
    return dispatch({
      _tag: "Review",
      staged: values.staged,
      ...(selectedBase === undefined ? {} : { base: selectedBase }),
      ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
      ephemeral: values.ephemeral,
      json: values.json,
      paths: values.paths,
    })
  },
)
