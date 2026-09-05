import * as ProductOperation from "@rika/product/product-operation"
import { Effect, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import type { ModeId } from "@rika/configuration/behavior-mode"
import { dispatch as dispatchHosted } from "./hosted"

const mode = Flag.string("mode").pipe(Flag.withAlias("m"), Flag.optional)
const thread = Flag.string("thread").pipe(Flag.optional)
const prompt = Argument.variadic(Argument.string("prompt"))

export const executeRun = (values: {
  readonly mode: Option.Option<ModeId>
  readonly thread: Option.Option<string>
  readonly prompt: ReadonlyArray<string>
  readonly workspace?: Option.Option<string>
  readonly ephemeral?: boolean
}) => {
  const threadId = Option.getOrUndefined(values.thread)
  const fail = (message: string) =>
    Effect.fail(
      CliError.UserError.make({
        cause: ProductOperation.InvalidInput.make({ message }),
        userMessage: message,
      }),
    )
  if (threadId === undefined) return fail("Execution requires --thread <thread-id>")
  if (values.workspace !== undefined && Option.isSome(values.workspace))
    return fail("Execution uses the Thread workspace; remove --workspace")
  if (values.ephemeral === true) return fail("Threads do not support --ephemeral")
  if (values.prompt.join("\n").trim().length === 0) return fail("Prompt must not be empty")
  const selectedMode = Option.getOrUndefined(values.mode)
  const request = selectedMode === undefined ? { prompt: values.prompt } : { prompt: values.prompt, mode: selectedMode }
  return dispatchHosted({ _tag: "RemoteRun", threadId, request })
}

export const runCommand = Command.make("run", { mode, thread, prompt }, executeRun).pipe(
  Command.withDescription("Submit a prompt to an existing Thread, wait for completion, and print its final answer"),
)
