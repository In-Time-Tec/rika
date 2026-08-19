import { Effect, Schema } from "effect"
import type { HostBindingRegistry } from "tenetkit/repl"
import * as CodingToolResult from "@rika/coding-tools/coding-tool-result"
import * as CodingToolRuntime from "@rika/coding-tools/coding-tool-runtime"
import * as ShellProcessRegistry from "@rika/coding-tools/shell-process-registry"
import { nested, NestedOperationFailed, operation, type Requirements } from "./nested-operation-envelope"

export const name = "processes"

const Failure = Schema.Union([CodingToolResult.ToolFailure, NestedOperationFailed])

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const Output = Schema.Struct({
  text: Schema.String,
  truncated: Schema.Boolean,
  running: Schema.optionalKey(Schema.Boolean),
  processId: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Finite),
  stdout: Schema.optionalKey(Schema.String),
  stderr: Schema.optionalKey(Schema.String),
})

const Stopped = Schema.Struct({ text: Schema.String, truncated: Schema.Boolean })

const StartInput = Schema.Struct({
  command: Schema.String,
  workdir: Schema.optionalKey(Schema.String),
  timeoutMillis: Schema.optionalKey(NonNegativeInt),
})
const StatusInput = Schema.Struct({ processId: Schema.String, waitMillis: Schema.optionalKey(NonNegativeInt) })
const StopInput = Schema.Struct({ processId: Schema.String })

const run = (request: typeof CodingToolRuntime.Request.Type) =>
  Effect.flatMap(CodingToolRuntime.Service, (runtime) => runtime.run(request))

const output = (result: CodingToolResult.Result) => ({
  text: result.text,
  truncated: result.truncated,
  ...(result.running === undefined ? {} : { running: result.running }),
  ...(result.processId === undefined ? {} : { processId: result.processId }),
  ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
  ...(result.stdout === undefined ? {} : { stdout: result.stdout }),
  ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
})

const stopFailure = (processId: string) =>
  CodingToolRuntime.ToolError.make({
    tool: "process_stop",
    message: `No running process is registered under id ${processId}. The call did not change state.`,
    kind: "operation",
    category: "not_found",
    outcome: "known",
    recovery: "after_change",
    nextAction: "List running processes and stop one that exists",
  })

export const operations: ReadonlyArray<
  HostBindingRegistry.AnyOperation<CodingToolRuntime.Service | ShellProcessRegistry.Service | Requirements>
> = [
  operation({
    name: "start",
    input: StartInput,
    output: Output,
    failure: Failure,
    handle: (input) =>
      nested(
        {
          kind: "process.start",
          payload: input,
          replayPolicy: "never",
          approval: { capability: "process.start", request: { command: input.command } },
        },
        Effect.map(
          run({
            _tag: "Bash",
            command: input.command,
            ...(input.workdir === undefined ? {} : { workdir: input.workdir }),
            ...(input.timeoutMillis === undefined ? {} : { timeoutMillis: input.timeoutMillis }),
          }),
          output,
        ),
      ),
  }),
  operation({
    name: "status",
    input: StatusInput,
    output: Output,
    failure: Failure,
    handle: (input) =>
      Effect.map(
        run({
          _tag: "ShellCommandStatus",
          processId: input.processId,
          ...(input.waitMillis === undefined ? {} : { waitMillis: input.waitMillis }),
        }),
        output,
      ),
  }),
  operation({
    name: "stop",
    input: StopInput,
    output: Stopped,
    failure: Failure,
    handle: (input) =>
      nested(
        { kind: "process.stop", payload: input, replayPolicy: "never" },
        Effect.flatMap(ShellProcessRegistry.Service, (registry) =>
          registry.cancel(input.processId).pipe(
            Effect.mapError(() => stopFailure(input.processId)),
            Effect.as({ text: `Stopped process ${input.processId}`, truncated: false }),
          ),
        ),
      ),
  }),
]

export const module: HostBindingRegistry.Module<
  CodingToolRuntime.Service | ShellProcessRegistry.Service | Requirements
> = { name, operations }
