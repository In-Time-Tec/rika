import { Console, Effect, FileSystem, Option } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { HostedError } from "../../hosted/hosted-contract"
import { dispatch as dispatchHosted } from "./hosted-command-dispatch"
import { authCommand } from "../product/auth-command"
import { organizationCommand } from "../product/organization-command"
import * as ReleaseUpdate from "../../release/release-update"
import { version } from "../../platform/application-version"

export { version }

const mode = Flag.string("mode").pipe(Flag.withAlias("m"), Flag.optional)
const workspace = Flag.directory("workspace").pipe(Flag.optional)
const thread = Flag.string("thread").pipe(Flag.optional)
const ephemeral = Flag.boolean("ephemeral")
const prompt = Argument.variadic(Argument.string("prompt"))
const streamFlags = {
  streamJson: Flag.boolean("stream-json"),
  streamJsonInput: Flag.boolean("stream-json-input"),
  streamJsonThinking: Flag.boolean("stream-json-thinking"),
}
const optionalValue = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value)

const unsupported = (name: string) =>
  Command.make(name, {}, () =>
    Effect.fail(
      HostedError.make({
        kind: "invalid-input",
        message: `${name} is not available in the hosted-only Rika client`,
      }),
    ),
  )

const updateCommand = Command.make("update", {}, () =>
  ReleaseUpdate.update({
    currentVersion: version,
    executable: process.execPath,
    host: { platform: process.platform, architecture: process.arch },
  }).pipe(
    Effect.flatMap((outcome) => Console.log(ReleaseUpdate.updateReport(outcome))),
    Effect.mapError((error) => HostedError.make({ kind: "network", message: error.message })),
  ),
).pipe(Command.withDescription("Replace this Rika install with the latest published release"))

const localForeground = (values: {
  readonly workspace: Option.Option<string>
  readonly thread: Option.Option<string>
}) => {
  const selectedWorkspace = optionalValue(values.workspace)
  const selectedThread = optionalValue(values.thread)
  const foreground = {
    _tag: "LocalForeground" as const,
    ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
    ...(selectedThread === undefined ? {} : { threadId: selectedThread }),
  }
  if (selectedWorkspace === undefined) return dispatchHosted(foreground)
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => Effect.result(fileSystem.stat(selectedWorkspace))),
    Effect.filterOrFail(
      (result) => result._tag === "Success" && result.success.type === "Directory",
      () => HostedError.make({ kind: "invalid-input", message: `Workspace is not a directory: ${selectedWorkspace}` }),
    ),
    Effect.flatMap(() => dispatchHosted(foreground)),
  )
}

const executeRemote = (values: {
  readonly mode: Option.Option<string>
  readonly thread: Option.Option<string>
  readonly prompt: ReadonlyArray<string>
}) => {
  const selectedThread = optionalValue(values.thread)
  if (selectedThread === undefined)
    return Effect.fail(HostedError.make({ kind: "invalid-input", message: "--execute requires --thread" }))
  if (selectedThread.startsWith("local_"))
    return Effect.fail(
      HostedError.make({
        kind: "invalid-input",
        message: "Local threads require the foreground TUI; do not use --execute",
      }),
    )
  if (values.prompt.length === 0)
    return Effect.fail(HostedError.make({ kind: "invalid-input", message: "--execute requires a prompt" }))
  const selectedMode = optionalValue(values.mode)
  return dispatchHosted({
    _tag: "RemoteRun",
    threadId: selectedThread,
    request: { prompt: values.prompt, ...(selectedMode === undefined ? {} : { mode: selectedMode }) },
  })
}

const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Manage hosted durable threads"),
  Command.withSubcommands([
    Command.make("new", { remote: Flag.boolean("remote") }, ({ remote }) =>
      dispatchHosted(remote ? { _tag: "RemoteThread", action: "new" } : { _tag: "LocalThread", action: "new" }),
    ),
    Command.make(
      "continue",
      { last: Flag.boolean("last"), threadIds: Argument.variadic(Argument.string("thread-id")) },
      ({ last, threadIds }) =>
        last || threadIds.length === 0
          ? dispatchHosted({ _tag: "LocalForeground" })
          : dispatchHosted({ _tag: "LocalForeground", threadId: threadIds[0] }),
    ),
    unsupported("list"),
    unsupported("search"),
    unsupported("rename"),
    unsupported("label"),
    unsupported("pin"),
    unsupported("archive"),
    unsupported("unarchive"),
    unsupported("delete"),
    unsupported("usage"),
    unsupported("fork"),
    unsupported("export"),
  ]),
)

export const command = Command.make(
  "rika",
  {
    execute: Flag.boolean("execute").pipe(Flag.withAlias("x")),
    mode,
    workspace,
    thread,
    ephemeral,
    ...streamFlags,
    prompt,
  },
  (values) => {
    if (values.execute) return executeRemote(values)
    if (values.streamJson || values.streamJsonInput || values.streamJsonThinking)
      return Effect.fail(HostedError.make({ kind: "invalid-input", message: "stream flags require --execute" }))
    return localForeground(values)
  },
).pipe(
  Command.withDescription("Hosted durable coding agent"),
  Command.withSubcommands([
    threadCommand,
    authCommand,
    organizationCommand,
    Command.make("last", {}, () => dispatchHosted({ _tag: "LocalForeground" })),
    Command.make("top", {}, () => dispatchHosted({ _tag: "LocalForeground" })),
    unsupported("run"),
    unsupported("diagnostics"),
    unsupported("credential"),
    unsupported("configuration"),
    unsupported("config"),
    unsupported("doctor"),
    unsupported("review"),
    unsupported("tool"),
    unsupported("skill"),
    unsupported("mcp"),
    unsupported("extension"),
    updateCommand,
    Command.make("version", {}, () => Console.log(version)),
  ]),
)

export const run = Effect.fn("RikaCli.run")(function* (argv: ReadonlyArray<string>) {
  return yield* Command.runWith(command, { version })(argv)
})
