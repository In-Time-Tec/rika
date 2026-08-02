import * as ProductOperation from "@rika/product/product-operation"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Option } from "effect"
import { dispatch } from "../root/cli-operation-dispatch"

const start = Command.make(
  "start",
  {
    name: Argument.choice("name", ["delivery", "research-synthesis"]),
    runId: Argument.string("run-id"),
    revision: Flag.integer("revision").pipe(Flag.optional),
  },
  ({ name, runId, revision }) => {
    const selectedRevision = Option.getOrUndefined(revision)
    const input: ProductOperation.Input = {
      _tag: "Workflow",
      action: "start",
      name,
      runId,
      ...(selectedRevision === undefined ? {} : { revision: selectedRevision }),
    }
    return dispatch(input)
  },
)

const inspect = Command.make("inspect", { runId: Argument.string("run-id") }, ({ runId }) =>
  dispatch({ _tag: "Workflow", action: "inspect", runId }),
)

const cancel = Command.make("cancel", { runId: Argument.string("run-id") }, ({ runId }) =>
  dispatch({ _tag: "Workflow", action: "cancel", runId }),
)

export const workflowCommand = Command.make("workflows").pipe(
  Command.withDescription("Run, inspect, and cancel built-in durable workflows"),
  Command.withSubcommands([start, inspect, cancel]),
)
