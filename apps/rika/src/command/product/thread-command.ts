import * as ProductOperation from "@rika/product/product-operation"
import { Effect } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { dispatch as dispatchHosted } from "../root/hosted-command-dispatch"
import { dispatch } from "../root/cli-operation-dispatch"

const continueCommand = Command.make(
  "continue",
  {
    last: Flag.boolean("last"),
    threadIds: Argument.variadic(Argument.string("thread-id")),
  },
  ({ last, threadIds }) =>
    Effect.gen(function* () {
      if (last && threadIds.length > 0) {
        return yield* ProductOperation.InvalidInput.make({
          message: "thread continue accepts --last or a thread id, not both",
        })
      }
      if (!last && threadIds.length === 0) {
        return yield* ProductOperation.InvalidInput.make({
          message: "thread continue requires --last or a thread id",
        })
      }
      if (threadIds.length > 1) {
        return yield* ProductOperation.InvalidInput.make({ message: "thread continue accepts exactly one thread id" })
      }
      if (last) {
        yield* dispatch({ _tag: "Interactive", prompt: [], last: true, ephemeral: false })
        return
      }
      yield* dispatch({ _tag: "Interactive", prompt: [], threadId: threadIds[0]!, ephemeral: false })
    }),
)

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Create or continue hosted durable Threads"),
  Command.withSubcommands([
    Command.make("new", {}, () => dispatchHosted({ _tag: "RemoteThread", action: "new" })),
    continueCommand,
  ]),
)
