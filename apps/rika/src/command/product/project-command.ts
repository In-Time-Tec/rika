import { Argument, Command } from "effect/unstable/cli"
import { dispatch } from "../root/hosted-command-dispatch"

const list = Command.make("list", {}, () => dispatch({ _tag: "Project", action: "list" }))

const create = Command.make("create", { name: Argument.string("name") }, ({ name }) =>
  dispatch({ _tag: "Project", action: "create", name }),
)

const use = Command.make("use", { project: Argument.string("project") }, ({ project }) =>
  dispatch({ _tag: "Project", action: "use", project }),
)

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Create, list, and select hosted Projects"),
  Command.withSubcommands([list, create, use]),
)
