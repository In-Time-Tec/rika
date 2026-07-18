import * as Operation from "@rika/app/operation-contract"
import { Console, Effect, Option, Schema, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { command as ConfigCommand } from "./commands/config"
import { command as DiagnosticsCommand } from "./commands/diagnostics"
import { command as ExtensionsCommand } from "./commands/extensions"
import { command as McpCommand } from "./commands/mcp"
import { command as SkillsCommand } from "./commands/skills"
import { dispatch } from "./commands/shared"
import { command as ThreadsCommand } from "./commands/threads"
import { command as ToolsCommand } from "./commands/tools"
import { command as WorkflowsCommand } from "./commands/workflows"

export const version = "0.0.0"

const mode = Flag.choice("mode", ["low", "medium", "high", "ultra"]).pipe(Flag.withAlias("m"), Flag.optional)
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
type RunOperation = Extract<Operation.Input, { readonly _tag: "Run" }>
const JsonLine = Schema.UnknownFromJsonString

const runInput = (values: {
  readonly mode: Option.Option<"low" | "medium" | "high" | "ultra">
  readonly workspace: Option.Option<string>
  readonly thread: Option.Option<string>
  readonly ephemeral: boolean
  readonly streamJson: boolean
  readonly streamJsonInput: boolean
  readonly streamJsonThinking: boolean
  readonly prompt: ReadonlyArray<string>
}): RunOperation => {
  const selectedMode = optionalValue(values.mode)
  const selectedWorkspace = optionalValue(values.workspace)
  const selectedThread = optionalValue(values.thread)
  return {
    _tag: "Run",
    prompt: values.prompt,
    ...(selectedMode === undefined ? {} : { mode: selectedMode }),
    ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
    ...(selectedThread === undefined ? {} : { threadId: selectedThread }),
    ephemeral: values.ephemeral,
    streamJson: values.streamJson,
    streamJsonInput: values.streamJsonInput,
    streamJsonThinking: values.streamJsonThinking,
  }
}

const validateRunInput = (input: RunOperation) => {
  if (input.streamJsonInput && !input.streamJson) {
    return Effect.fail(Operation.InvalidInput.make({ message: "--stream-json-input requires --stream-json" }))
  }
  if (input.streamJsonThinking && !input.streamJson) {
    return Effect.fail(Operation.InvalidInput.make({ message: "--stream-json-thinking requires --stream-json" }))
  }
  return Effect.succeed(input)
}

export const parseJsonLines = (input: string): ReadonlyArray<string> =>
  input.split("\n").flatMap((line, index) => {
    if (line.trim().length === 0) return []
    const decoded = Schema.decodeUnknownOption(JsonLine)(line)
    if (Option.isNone(decoded)) {
      throw Operation.InvalidInput.make({ message: `Invalid JSON on stdin line ${index + 1}` })
    }
    const value = decoded.value
    if (typeof value === "string") return [value]
    if (typeof value === "object" && value !== null && "prompt" in value && typeof value.prompt === "string")
      return [value.prompt]
    throw Operation.InvalidInput.make({
      message: `JSON on stdin line ${index + 1} must be a string or prompt object`,
    })
  })

export function readStreamInput(
  stdin: AsyncIterable<unknown>,
): (input: RunOperation) => Effect.Effect<RunOperation, Operation.InvalidInput>
export function readStreamInput(): (
  input: RunOperation,
) => Effect.Effect<RunOperation, Operation.InvalidInput, Stdio.Stdio>
export function readStreamInput(
  input: RunOperation,
  stdin: AsyncIterable<unknown>,
): Effect.Effect<RunOperation, Operation.InvalidInput>
export function readStreamInput(input: RunOperation): Effect.Effect<RunOperation, Operation.InvalidInput, Stdio.Stdio>
export function readStreamInput(
  inputOrStdin?: RunOperation | AsyncIterable<unknown>,
  stdin?: AsyncIterable<unknown>,
):
  | Effect.Effect<RunOperation, Operation.InvalidInput, Stdio.Stdio>
  | ((input: RunOperation) => Effect.Effect<RunOperation, Operation.InvalidInput, Stdio.Stdio>) {
  if (inputOrStdin === undefined || !("_tag" in inputOrStdin)) {
    const selectedStdin = inputOrStdin ?? stdin
    return selectedStdin === undefined
      ? (input) => readStreamInput(input)
      : (input) => readStreamInput(input, selectedStdin)
  }
  const input = inputOrStdin
  if (!input.streamJsonInput || input.prompt.length > 0) return Effect.succeed(input)
  const stdinText =
    stdin === undefined
      ? Stdio.Stdio.pipe(
          Effect.flatMap((stdio) => Stream.mkString(Stream.decodeText(stdio.stdin))),
          Effect.mapError((cause) =>
            Operation.InvalidInput.make({ message: `Unable to read JSON input: ${String(cause)}` }),
          ),
        )
      : Stream.fromAsyncIterable(stdin, (cause) =>
          Operation.InvalidInput.make({ message: `Unable to read JSON input: ${String(cause)}` }),
        ).pipe(
          Stream.runFold(
            () => "",
            (accumulated, chunk) => accumulated + String(chunk),
          ),
        )
  return stdinText.pipe(
    Effect.flatMap((content) =>
      Effect.try({
        try: () => ({ ...input, prompt: [...input.prompt, ...parseJsonLines(content)] }),
        catch: (cause) =>
          Schema.is(Operation.InvalidInput)(cause)
            ? cause
            : Operation.InvalidInput.make({ message: `Unable to parse JSON input: ${String(cause)}` }),
      }),
    ),
  )
}

const runCommand = Command.make(
  "run",
  {
    mode,
    workspace,
    thread,
    ephemeral,
    ...streamFlags,
    prompt,
  },
  (values) => validateRunInput(runInput(values)).pipe(Effect.flatMap(readStreamInput), Effect.flatMap(dispatch)),
).pipe(Command.withDescription("Run Rika non-interactively"))

const reviewCommand = Command.make(
  "review",
  {
    staged: Flag.boolean("staged"),
    base: Flag.string("base").pipe(Flag.optional),
    workspace,
    ephemeral,
    json: Flag.boolean("json"),
    paths: Argument.variadic(Argument.string("path")),
  },
  (values) => {
    const selectedBase = optionalValue(values.base)
    const selectedWorkspace = optionalValue(values.workspace)
    return dispatch({
      _tag: "Review",
      staged: values.staged,
      ...(selectedBase === undefined ? {} : { base: selectedBase }),
      ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
      ephemeral: values.ephemeral,
      json: values.json,
      paths: values.paths,
    })
  },
)

const versionCommand = Command.make("version", {}, () => Console.log(version))

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
    if (values.execute)
      return validateRunInput(runInput(values)).pipe(Effect.flatMap(readStreamInput), Effect.flatMap(dispatch))
    if (values.streamJson || values.streamJsonInput || values.streamJsonThinking) {
      return Effect.fail(Operation.InvalidInput.make({ message: "stream flags require --execute or the run command" }))
    }
    const selectedMode = optionalValue(values.mode)
    const selectedWorkspace = optionalValue(values.workspace)
    const selectedThread = optionalValue(values.thread)
    return dispatch({
      _tag: "Interactive",
      prompt: values.prompt,
      ...(selectedMode === undefined ? {} : { mode: selectedMode }),
      ...(selectedWorkspace === undefined ? {} : { workspace: selectedWorkspace }),
      ...(selectedThread === undefined ? {} : { threadId: selectedThread }),
      ephemeral: values.ephemeral,
    })
  },
).pipe(
  Command.withDescription("Local durable coding agent"),
  Command.withSubcommands([
    runCommand,
    ThreadsCommand,
    Command.make("last", {}, () => dispatch({ _tag: "Thread", action: "last" })),
    Command.make("top", {}, () => dispatch({ _tag: "Thread", action: "top" })),
    ConfigCommand,
    DiagnosticsCommand,
    ToolsCommand,
    SkillsCommand,
    McpCommand,
    ExtensionsCommand,
    WorkflowsCommand,
    reviewCommand,
    Command.make("doctor", {}, () => dispatch({ _tag: "Doctor" })),
    Command.make("update", {}, () => dispatch({ _tag: "Update" })),
    versionCommand,
  ]),
)

export const run = Effect.fn("RikaCli.run")(function* (argv: ReadonlyArray<string>) {
  return yield* Command.runWith(command, { version })(argv)
})
