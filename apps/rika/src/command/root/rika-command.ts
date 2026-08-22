import * as ProductOperation from "@rika/product/product-operation"
import { Console, Effect, FileSystem, Option, Stdio } from "effect"
import { Argument, CliError, Command, Flag } from "effect/unstable/cli"
import type { ModeId } from "@rika/configuration/behavior-mode"
import { authCommand } from "../product/auth-command"
import { credentialCommand } from "../product/credential-command"
import { diagnosticsCommand } from "../product/diagnostics-command"
import { organizationCommand } from "../product/organization-command"
import { threadCommand } from "../product/thread-command"
import { dispatch, type CliOperationService } from "./cli-operation-dispatch"
import { executeRun, runCommand } from "./noninteractive-run-command"
import * as LocalRunnerCommand from "./local-runner-command"
import * as ReleaseUpdate from "../../release/release-update"
import { version } from "../../platform/application-version"
import { localExecutorProcessRole, tuiControllerProcessRole } from "../../private-runtime-role"

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
    execute: Flag.boolean("execute").pipe(Flag.withAlias("x")),
    mode,
    workspace,
    thread,
    ephemeral,
    noTui: Flag.boolean("no-tui"),
    allowRemoteThreadCreation: Flag.boolean("allow-remote-thread-creation"),
    denyRemoteThreadCreation: Flag.boolean("deny-remote-thread-creation"),
    internalTuiController: Flag.boolean(tuiControllerProcessRole.slice(2)).pipe(Flag.withHidden),
    internalLocalExecutor: Flag.boolean(localExecutorProcessRole.slice(2)).pipe(Flag.withHidden),
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
      return LocalRunnerCommand.dispatch({
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
    credentialCommand,
    diagnosticsCommand,
    updateCommand,
    Command.make("version", {}, () => Console.log(version)),
  ]),
)

export const run = Effect.fn("RikaCli.run")(function* (argv: ReadonlyArray<string>) {
  return yield* Command.runWith(command, { version })(argv)
})
