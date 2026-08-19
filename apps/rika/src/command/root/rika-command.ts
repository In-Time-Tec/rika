import * as ProductOperation from "@rika/product/product-operation"
import { Console, Effect, FileSystem, Option, Stdio } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import type { ModeId } from "@rika/configuration/behavior-mode"
import { authCommand } from "../product/auth-command"
import { configurationCommand } from "../product/configuration-command"
import { credentialCommand } from "../product/credential-command"
import { diagnosticsCommand } from "../product/diagnostics-command"
import { extensionCommand } from "../product/extension-command"
import { mcpCommand } from "../product/mcp-command"
import { organizationCommand } from "../product/organization-command"
import { skillCommand } from "../product/skill-command"
import { threadCommand } from "../product/thread-command"
import { toolCatalogCommand } from "../product/tool-catalog-command"
import { reviewCommand } from "../product/review-command"
import { dispatch, type CliOperationService } from "./cli-operation-dispatch"
import { executeRun, runCommand } from "./noninteractive-run-command"
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

const updateCommand = Command.make("update", {}, () =>
  ReleaseUpdate.update({
    currentVersion: version,
    executable: process.execPath,
    host: { platform: process.platform, architecture: process.arch },
  }).pipe(
    Effect.flatMap((outcome) => Console.log(ReleaseUpdate.updateReport(outcome))),
    Effect.mapError((error) =>
      ProductOperation.OperationUnavailable.make({ operation: "Update", message: error.message }),
    ),
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
      () => ProductOperation.InvalidInput.make({ message: `Workspace is not a directory: ${selectedWorkspace}` }),
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
    ...streamFlags,
    prompt,
  },
  (
    values,
  ): Effect.Effect<
    void,
    ProductOperation.InvalidInput | ProductOperation.OperationUnavailable,
    FileSystem.FileSystem | CliOperationService | Stdio.Stdio
  > => {
    if (values.execute) return executeRun(values)
    if (values.streamJson || values.streamJsonInput || values.streamJsonThinking)
      return Effect.fail(
        ProductOperation.InvalidInput.make({ message: "stream flags require --execute or the run command" }),
      )
    return interactiveCommand(values)
  },
).pipe(
  Command.withDescription("Local durable coding agent"),
  Command.withSubcommands([
    runCommand,
    reviewCommand,
    threadCommand,
    Command.make("last", {}, () => dispatch({ _tag: "Thread", action: "last" })),
    Command.make("top", {}, () => dispatch({ _tag: "Thread", action: "top" })),
    configurationCommand,
    organizationCommand,
    authCommand,
    credentialCommand,
    diagnosticsCommand,
    toolCatalogCommand,
    skillCommand,
    mcpCommand,
    extensionCommand,
    Command.make("doctor", {}, () => dispatch({ _tag: "Doctor" })),
    updateCommand,
    Command.make("version", {}, () => Console.log(version)),
  ]),
)

export const run = Effect.fn("RikaCli.run")(function* (argv: ReadonlyArray<string>) {
  return yield* Command.runWith(command, { version })(argv)
})
