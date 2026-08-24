import * as ProductOperation from "@rika/product/product-operation"
import { Console, Effect, FileSystem, Option, Stdio } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import type { ModeId } from "@rika/configuration/behavior-mode"
import { authCommand } from "../product/auth"
import { credentialCommand } from "../product/credential"
import { diagnosticsCommand } from "../product/diagnostics"
import { organizationCommand } from "../product/organization"
import { projectCommand } from "../product/project"
import { providerCommand } from "../product/provider"
import { secretCommand } from "../product/secret"
import { threadCommand } from "../product/thread"
import { dispatch, type CliOperationService } from "./cli-operation"
import { executeRun, runCommand } from "./noninteractive"
import * as RunnerCommand from "./runner"
import * as ReleaseUpdate from "../../release/update"
import { version } from "../../platform/application-version"

export { version }

const mode = Flag.string("mode").pipe(Flag.withAlias("m"), Flag.optional)
const workspace = Flag.directory("workspace").pipe(Flag.optional)
const thread = Flag.string("thread").pipe(Flag.optional)
const ephemeral = Flag.boolean("ephemeral").pipe(Flag.withDefault(false))
const prompt = Argument.variadic(Argument.string("prompt"))
const streamFlags = {
  streamJson: Flag.boolean("stream-json").pipe(Flag.withDefault(false)),
  streamJsonInput: Flag.boolean("stream-json-input").pipe(Flag.withDefault(false)),
  streamJsonThinking: Flag.boolean("stream-json-thinking").pipe(Flag.withDefault(false)),
}
const optionalValue = <A>(value: Option.Option<A>): A | undefined => Option.getOrUndefined(value)

const updateCommand = Command.make("update", {}, () =>
  ReleaseUpdate.update({
    currentVersion: version,
    executable: process.execPath,
    host: { platform: process.platform, architecture: process.arch },
  }).pipe(
    Effect.flatMap((outcome) => Console.log(ReleaseUpdate.updateReport(outcome))),
    Effect.mapError((error) => CliError.UserError.make({ cause: error, userMessage: error.message })),
  ),
).pipe(Command.withDescription("Replace this Rika install with the latest published release"))

const interactiveCommand = (values: {
  readonly mode: Option.Option<ModeId>
  readonly workspace: Option.Option<string>
  readonly thread: Option.Option<string>
  readonly ephemeral: boolean
  readonly prompt: ReadonlyArray<string>
}) => {
  const selectedMode = optionalValue(values.mode)
  const selectedWorkspace = optionalValue(values.workspace)
  const selectedThread = optionalValue(values.thread)
  const input: ProductOperation.Input = {
    _tag: "Interactive",
    prompt: values.prompt,
    ...(selectedMode === undefined ? {} : { mode: selectedMode }),
    ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
    ...(selectedThread === undefined ? {} : { threadId: selectedThread }),
    ephemeral: values.ephemeral,
  }
  if (selectedWorkspace === undefined) return dispatch(input)
  return FileSystem.FileSystem.pipe(
    Effect.flatMap((fileSystem) => Effect.result(fileSystem.stat(selectedWorkspace))),
    Effect.filterOrFail(
      (result) => result._tag === "Success" && result.success.type === "Directory",
      () =>
        CliError.UserError.make({
          cause: ProductOperation.InvalidInput.make({ message: `Workspace is not a directory: ${selectedWorkspace}` }),
          userMessage: `Workspace is not a directory: ${selectedWorkspace}`,
        }),
    ),
    Effect.flatMap(() => dispatch(input)),
  )
}

export const command = Command.make(
  "rika",
  {
    execute: Flag.boolean("execute").pipe(Flag.withDefault(false), Flag.withAlias("x")),
    mode,
    workspace,
    thread,
    ephemeral,
    noTui: Flag.boolean("no-tui").pipe(Flag.withDefault(false)),
    allowRemoteThreadCreation: Flag.boolean("allow-remote-thread-creation").pipe(Flag.withDefault(false)),
    denyRemoteThreadCreation: Flag.boolean("deny-remote-thread-creation").pipe(Flag.withDefault(false)),
    ...streamFlags,
    prompt,
  },
  (values): Effect.Effect<void, CliError.UserError, FileSystem.FileSystem | CliOperationService | Stdio.Stdio> => {
    if (values.allowRemoteThreadCreation && values.denyRemoteThreadCreation)
      return Effect.fail(
        CliError.UserError.make({
          cause: "Conflicting remote Thread admission flags",
          userMessage: "--allow-remote-thread-creation and --deny-remote-thread-creation are mutually exclusive",
        }),
      )
    if ((values.allowRemoteThreadCreation || values.denyRemoteThreadCreation) && !values.noTui)
      return Effect.fail(
        CliError.UserError.make({
          cause: "Remote Thread admission flags require headless mode",
          userMessage: "remote Thread admission flags require --no-tui",
        }),
      )
    if (values.noTui) {
      let remoteThreadCreation: "allowed" | "denied" | undefined
      if (values.allowRemoteThreadCreation) remoteThreadCreation = "allowed"
      else if (values.denyRemoteThreadCreation) remoteThreadCreation = "denied"
      return RunnerCommand.dispatch({
        ...(optionalValue(values.workspace) === undefined ? {} : { workspace: optionalValue(values.workspace) }),
        ...(remoteThreadCreation === undefined ? {} : { remoteThreadCreation }),
      })
    }
    if (values.execute) return executeRun(values)
    if (values.streamJson || values.streamJsonInput || values.streamJsonThinking)
      return Effect.fail(
        CliError.UserError.make({
          cause: "Stream flags require non-interactive execution",
          userMessage: "stream flags require --execute or the run command",
        }),
      )
    return interactiveCommand(values)
  },
).pipe(
  Command.withDescription("Hosted durable coding agent"),
  Command.withSubcommands([
    runCommand,
    threadCommand,
    organizationCommand,
    authCommand,
    projectCommand,
    secretCommand,
    credentialCommand,
    providerCommand,
    diagnosticsCommand,
    updateCommand,
    Command.make("version", {}, () => Console.log(version)),
  ]),
)

export const run = Effect.fn("RikaCli.run")(function* (argv: ReadonlyArray<string>) {
  return yield* Command.runWith(command, { version })(argv)
})
