import { Effect, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { dispatch } from "../root/hosted"

export const reviewCommand = Command.make(
  "review",
  {
    thread: Flag.string("thread"),
    mode: Flag.string("mode").pipe(Flag.withAlias("m"), Flag.optional),
    prompt: Argument.variadic(Argument.string("request")),
  },
  ({ thread, mode, prompt }) => {
    if (prompt.join(" ").trim().length === 0)
      return Effect.fail(
        CliError.UserError.make({ cause: "Empty review request", userMessage: "Review request must not be empty" }),
      )
    const request = { prompt, review: true as const }
    return dispatch({
      _tag: "RemoteRun",
      threadId: thread,
      request: Option.isSome(mode) ? { ...request, mode: mode.value } : request,
    })
  },
).pipe(Command.withDescription("Run a durable correctness, security, and quality review in an existing Thread"))
