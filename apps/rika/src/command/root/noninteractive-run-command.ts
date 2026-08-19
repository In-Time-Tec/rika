import * as ProductOperation from "@rika/product/product-operation"
import { Effect, Option, Schema, Stdio, Stream } from "effect"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { modeIds, type ModeId } from "@rika/configuration/behavior-mode"
import { dispatch } from "./cli-operation-dispatch"

const mode = Flag.choice("mode", modeIds).pipe(Flag.withAlias("m"), Flag.optional)
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
type RunOperation = Extract<ProductOperation.Input, { readonly _tag: "Run" }>
const JsonLine = Schema.fromJsonString(Schema.Unknown)

const runInput = (values: {
  readonly mode: Option.Option<ModeId>
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
  if (input.streamJsonInput && !input.streamJson)
    return Effect.fail(ProductOperation.InvalidInput.make({ message: "--stream-json-input requires --stream-json" }))
  if (input.streamJsonThinking && !input.streamJson)
    return Effect.fail(ProductOperation.InvalidInput.make({ message: "--stream-json-thinking requires --stream-json" }))
  return Effect.succeed(input)
}

export const parseJsonLines = (input: string): ReadonlyArray<string> =>
  input.split("\n").flatMap((line, index) => {
    if (line.trim().length === 0) return []
    const decoded = Schema.decodeUnknownOption(JsonLine)(line)
    if (Option.isNone(decoded))
      throw ProductOperation.InvalidInput.make({ message: `Invalid JSON on stdin line ${index + 1}` })
    const value = decoded.value
    if (typeof value === "string") return [value]
    if (typeof value === "object" && value !== null && "prompt" in value && typeof value.prompt === "string")
      return [value.prompt]
    throw ProductOperation.InvalidInput.make({
      message: `JSON on stdin line ${index + 1} must be a string or prompt object`,
    })
  })

export function readStreamInput(
  stdin: AsyncIterable<unknown>,
): (input: RunOperation) => Effect.Effect<RunOperation, ProductOperation.InvalidInput>
export function readStreamInput(): (
  input: RunOperation,
) => Effect.Effect<RunOperation, ProductOperation.InvalidInput, Stdio.Stdio>
export function readStreamInput(
  input: RunOperation,
  stdin: AsyncIterable<unknown>,
): Effect.Effect<RunOperation, ProductOperation.InvalidInput>
export function readStreamInput(
  input: RunOperation,
): Effect.Effect<RunOperation, ProductOperation.InvalidInput, Stdio.Stdio>
export function readStreamInput(
  inputOrStdin?: RunOperation | AsyncIterable<unknown>,
  stdin?: AsyncIterable<unknown>,
):
  | Effect.Effect<RunOperation, ProductOperation.InvalidInput, Stdio.Stdio>
  | ((input: RunOperation) => Effect.Effect<RunOperation, ProductOperation.InvalidInput, Stdio.Stdio>) {
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
            ProductOperation.InvalidInput.make({ message: `Unable to read JSON input: ${String(cause)}` }),
          ),
        )
      : Stream.fromAsyncIterable(stdin, (cause) =>
          ProductOperation.InvalidInput.make({ message: `Unable to read JSON input: ${String(cause)}` }),
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
          Schema.is(ProductOperation.InvalidInput)(cause)
            ? cause
            : ProductOperation.InvalidInput.make({ message: `Unable to parse JSON input: ${String(cause)}` }),
      }),
    ),
  )
}

export const executeRun = (values: Parameters<typeof runInput>[0]) =>
  validateRunInput(runInput(values)).pipe(Effect.flatMap(readStreamInput), Effect.flatMap(dispatch))

export const runCommand = Command.make(
  "run",
  { mode, workspace, thread, ephemeral, ...streamFlags, prompt },
  executeRun,
).pipe(Command.withDescription("Run Rika non-interactively"))
