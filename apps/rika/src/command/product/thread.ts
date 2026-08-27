import * as ProductOperation from "@rika/product/product-operation"
import { Effect, Option } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import { dispatch as dispatchHosted } from "../root/hosted"
import { dispatch } from "../root/cli-operation"
const invalid = (message: string) => {
  const cause = ProductOperation.InvalidInput.make({ message })
  return CliError.UserError.make({ cause, userMessage: message })
}

const continueCommand = Command.make(
  "continue",
  {
    last: Flag.boolean("last").pipe(Flag.withDefault(false)),
    threadIds: Argument.variadic(Argument.string("thread-id")),
  },
  ({ last, threadIds }) =>
    Effect.gen(function* () {
      if (last && threadIds.length > 0) return yield* invalid("thread continue accepts --last or a thread id, not both")
      if (!last && threadIds.length === 0) return yield* invalid("thread continue requires --last or a thread id")
      if (threadIds.length > 1) return yield* invalid("thread continue accepts exactly one thread id")
      if (last) {
        yield* dispatch({ _tag: "Interactive", prompt: [], last: true, ephemeral: false })
        return
      }
      yield* dispatch({ _tag: "Interactive", prompt: [], threadId: threadIds[0]!, ephemeral: false })
    }),
)

const serviceCommand = Command.make("service").pipe(
  Command.withDescription("Control repository services in a Thread Workspace"),
  Command.withSubcommands([
    Command.make(
      "start",
      {
        threadId: Argument.string("thread-id"),
        serviceId: Argument.string("service-id"),
        command: Argument.string("command"),
        args: Argument.variadic(Argument.string("arg")),
        cwd: Flag.string("cwd").pipe(Flag.withDefault(".")),
      },
      ({ threadId, serviceId, command, args, cwd }) =>
        dispatchHosted({
          _tag: "ThreadService",
          action: "ensure",
          threadId,
          service: { serviceId, command, args, cwd },
        }),
    ),
    Command.make(
      "stop",
      { threadId: Argument.string("thread-id"), serviceId: Argument.string("service-id") },
      ({ threadId, serviceId }) => dispatchHosted({ _tag: "ThreadService", action: "stop", threadId, serviceId }),
    ),
  ]),
)

const portalCommand = Command.make(
  "portal",
  { threadId: Argument.string("thread-id"), port: Argument.integer("port") },
  ({ threadId, port }) => dispatchHosted({ _tag: "ThreadPortal", threadId, port }),
).pipe(Command.withDescription("Open an authenticated portal to an Orb service"))

const syncCommand = Command.make(
  "sync",
  {
    threadId: Argument.string("thread-id"),
    commitSha: Argument.string("commit-sha"),
    targetBranch: Flag.string("target").pipe(Flag.optional),
    title: Flag.string("title").pipe(Flag.optional),
    body: Flag.string("body").pipe(Flag.optional),
  },
  ({ threadId, commitSha, targetBranch, title, body }) => {
    const operation = {
      _tag: "ThreadSync",
      threadId,
      commitSha,
      title: Option.getOrElse(title, () => `Rika: synchronize ${commitSha.slice(0, 12)}`),
      body: Option.getOrElse(body, () => ""),
    } as const
    return Option.isSome(targetBranch)
      ? dispatchHosted({ ...operation, targetBranch: targetBranch.value })
      : dispatchHosted(operation)
  },
).pipe(Command.withDescription("Publish an approved Thread commit to its repository"))

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Create or continue durable Threads"),
  Command.withSubcommands([
    Command.make("new", {}, () => dispatchHosted({ _tag: "RemoteThread", action: "new" })),
    continueCommand,
    serviceCommand,
    portalCommand,
    syncCommand,
  ]),
)
